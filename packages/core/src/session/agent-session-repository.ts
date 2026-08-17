import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { InterprocessFileLock } from "../persistence";
import { isAgentId } from "../identifiers";
import {
  assertTranscriptMessages,
  cloneTranscriptMessage,
  cloneTranscriptMessages,
} from "../messages";
import { cloneData } from "../dataCopy";
import { assertEnvironmentContextRecord, type EnvironmentContextRecord } from "../environment";
import type { TranscriptMessage } from "../messages";

import type { SessionEntry, SessionIndex, SessionRecord, SessionSnapshot } from "./types";

export interface AgentSession {
  readonly id: string;
  readonly messages: readonly TranscriptMessage[];
  readonly environment?: EnvironmentContextRecord;
}

export interface AgentSessionRepositoryOptions {
  readonly agentId: string;
  readonly sessionsRoot: string;
}

export class AgentSessionRepository {
  private readonly directory: string;
  private readonly indexPath: string;
  private readonly lockPath: string;
  private readonly lock: InterprocessFileLock;
  private activeId: string | null = null;
  private activeMessages: TranscriptMessage[] = [];
  private activeEnvironment: EnvironmentContextRecord | undefined;
  private revision = 0;

  constructor(options: AgentSessionRepositoryOptions) {
    assertAgentId(options.agentId);
    this.directory = join(options.sessionsRoot, options.agentId);
    this.indexPath = join(this.directory, "index.json");
    this.lockPath = join(this.directory, ".lock");
    this.lock = new InterprocessFileLock(this.lockPath, { retryMs: 25, timeoutMs: 5_000 });
  }

  get currentId(): string | null {
    return this.activeId;
  }

  snapshot(): SessionSnapshot {
    if (!this.activeId) throw new Error("Agent session is not initialized");
    return {
      sessionId: this.activeId,
      revision: this.revision,
      messages: cloneTranscriptMessages(this.activeMessages),
      ...(this.activeEnvironment
        ? { environment: cloneData(this.activeEnvironment) as EnvironmentContextRecord }
        : {}),
    };
  }

  async restoreLatestOrCreate(): Promise<AgentSession> {
    const session = await this.exclusive(async () => {
      const index = await this.readIndex();
      if (index.sessions.length === 0) return this.createPersistedSession(index);

      const entry = [...index.sessions].sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
      return this.replay(entry.id);
    });
    return this.activate(session);
  }

  async create(): Promise<AgentSession> {
    const session = await this.exclusive(async () =>
      this.createPersistedSession(await this.readIndex()),
    );
    return this.activate(session);
  }

  async switchTo(sessionId: string): Promise<AgentSession> {
    assertSessionId(sessionId);
    const session = await this.exclusive(async () => {
      const index = await this.readIndex();
      if (!index.sessions.some((entry) => entry.id === sessionId)) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      return this.replay(sessionId);
    });
    return this.activate(session);
  }

  async append(sessionId: string, records: readonly SessionRecord[]): Promise<void> {
    if (records.length === 0) return;
    assertSessionId(sessionId);
    const ownedRecords = records.map(cloneSessionRecord);
    await this.exclusive(async () => {
      const index = await this.readIndex();
      const entry = index.sessions.find((candidate) => candidate.id === sessionId);
      if (!entry) throw new Error(`Session not found: ${sessionId}`);

      const lines = `${ownedRecords.map((record) => JSON.stringify(record)).join("\n")}\n`;
      await appendFile(this.sessionPath(sessionId), lines, { encoding: "utf8", mode: 0o600 });
      entry.lastActiveAt = Date.now();
      await this.writeIndex(index);
    });
    if (this.activeId === sessionId) {
      this.applyRecords(ownedRecords);
      this.revision += 1;
    }
  }

  async clear(sessionId: string): Promise<void> {
    assertSessionId(sessionId);
    await this.exclusive(async () => {
      const index = await this.readIndex();
      if (!index.sessions.some((entry) => entry.id === sessionId)) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      await writeFile(this.sessionPath(sessionId), "", { encoding: "utf8", mode: 0o600 });
    });
    if (this.activeId === sessionId) {
      this.activeMessages = [];
      this.activeEnvironment = undefined;
      this.revision += 1;
    }
  }

  private async createPersistedSession(index: SessionIndex): Promise<AgentSession> {
    const latestTimestamp = index.sessions.reduce(
      (latest, entry) => Math.max(latest, entry.lastActiveAt),
      0,
    );
    const now = Math.max(Date.now(), latestTimestamp + 1);
    const entry: SessionEntry = { id: randomUUID(), createdAt: now, lastActiveAt: now };
    index.sessions.push(entry);
    await this.writeIndex(index);
    await writeFile(this.sessionPath(entry.id), "", { encoding: "utf8", mode: 0o600 });
    return { id: entry.id, messages: [] };
  }

  private activate(session: AgentSession): AgentSession {
    this.activeId = session.id;
    this.activeMessages = cloneTranscriptMessages(session.messages);
    this.activeEnvironment = session.environment
      ? (cloneData(session.environment) as EnvironmentContextRecord)
      : undefined;
    this.revision = 0;
    return {
      id: session.id,
      messages: cloneTranscriptMessages(this.activeMessages),
      ...(this.activeEnvironment
        ? { environment: cloneData(this.activeEnvironment) as EnvironmentContextRecord }
        : {}),
    };
  }

  private async readIndex(): Promise<SessionIndex> {
    try {
      const parsed = JSON.parse(await readFile(this.indexPath, "utf8")) as SessionIndex;
      if (!Array.isArray(parsed.sessions)) throw new Error("Session index is invalid");
      for (const entry of parsed.sessions) assertSessionEntry(entry);
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { sessions: [] };
      throw error;
    }
  }

  private async writeIndex(index: SessionIndex): Promise<void> {
    const temporaryPath = `${this.indexPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(index, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporaryPath, this.indexPath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  private async replay(sessionId: string): Promise<AgentSession> {
    try {
      const messages: TranscriptMessage[] = [];
      let environment: EnvironmentContextRecord | undefined;
      let environmentRevision = 0;
      for (const line of (await readFile(this.sessionPath(sessionId), "utf8")).split("\n")) {
        if (!line.trim()) continue;
        const record = JSON.parse(line) as unknown;
        assertSessionRecord(record);
        if (record.kind === "message") {
          messages.push(cloneTranscriptMessage(record.message));
        } else {
          if (record.context.revision !== environmentRevision + 1) {
            throw new Error("Session environment revisions are not contiguous");
          }
          environment = cloneData(record.context) as EnvironmentContextRecord;
          environmentRevision = environment.revision;
        }
      }
      return { id: sessionId, messages, ...(environment ? { environment } : {}) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { id: sessionId, messages: [] };
      }
      throw error;
    }
  }

  private applyRecords(records: readonly SessionRecord[]): void {
    for (const record of records) {
      if (record.kind === "message") {
        this.activeMessages.push(cloneTranscriptMessage(record.message));
      } else {
        this.activeEnvironment = cloneData(record.context) as EnvironmentContextRecord;
      }
    }
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true });
    return this.lock.runExclusive(operation);
  }

  private sessionPath(sessionId: string): string {
    return join(this.directory, `${sessionId}.jsonl`);
  }
}

function cloneSessionRecord(record: SessionRecord): SessionRecord {
  return record.kind === "message"
    ? { kind: "message", message: cloneTranscriptMessage(record.message) }
    : { kind: "environment", context: cloneData(record.context) as EnvironmentContextRecord };
}

function assertSessionRecord(value: unknown): asserts value is SessionRecord {
  if (!value || typeof value !== "object") throw new Error("Session record is invalid");
  const record = value as { kind?: unknown; message?: unknown; context?: unknown };
  if (record.kind === "message") {
    assertTranscriptMessages(
      [record.message],
      (message) => new Error(`Session message record ${message}`),
    );
    return;
  }
  if (record.kind === "environment") {
    assertEnvironmentContextRecord(record.context);
    return;
  }
  throw new Error('Session record kind must be "message" or "environment"');
}

function assertAgentId(agentId: string): void {
  if (!isAgentId(agentId)) {
    throw new Error(`Invalid agent id: ${agentId}`);
  }
}

function assertSessionId(sessionId: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error(`Invalid session id: ${sessionId}`);
}

function assertSessionEntry(value: unknown): asserts value is SessionEntry {
  if (!value || typeof value !== "object") throw new Error("Session index entry is invalid");
  const entry = value as Partial<SessionEntry>;
  if (
    typeof entry.id !== "string" ||
    typeof entry.createdAt !== "number" ||
    typeof entry.lastActiveAt !== "number"
  ) {
    throw new Error("Session index entry is invalid");
  }
  assertSessionId(entry.id);
}
