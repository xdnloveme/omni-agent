import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { InterprocessFileLock } from "../persistence";
import { isAgentId } from "../identifiers";
import { cloneTranscriptMessages } from "../messages";
import type { TranscriptMessage } from "../messages";

import type { SessionEntry, SessionIndex, SessionTranscriptSnapshot } from "./types";

export interface AgentSession {
  readonly id: string;
  readonly messages: readonly TranscriptMessage[];
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

  snapshot(): SessionTranscriptSnapshot {
    if (!this.activeId) throw new Error("Agent session is not initialized");
    return {
      sessionId: this.activeId,
      revision: this.revision,
      messages: cloneTranscriptMessages(this.activeMessages),
    };
  }

  async restoreLatestOrCreate(): Promise<AgentSession> {
    const session = await this.exclusive(async () => {
      const index = await this.readIndex();
      if (index.sessions.length === 0) return this.createPersistedSession(index);

      const entry = [...index.sessions].sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
      return { id: entry.id, messages: await this.replay(entry.id) };
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
      return { id: sessionId, messages: await this.replay(sessionId) };
    });
    return this.activate(session);
  }

  async append(sessionId: string, messages: readonly TranscriptMessage[]): Promise<void> {
    if (messages.length === 0) return;
    assertSessionId(sessionId);
    const ownedMessages = cloneTranscriptMessages(messages);
    await this.exclusive(async () => {
      const index = await this.readIndex();
      const entry = index.sessions.find((candidate) => candidate.id === sessionId);
      if (!entry) throw new Error(`Session not found: ${sessionId}`);

      const lines = `${ownedMessages.map((message) => JSON.stringify(message)).join("\n")}\n`;
      await appendFile(this.sessionPath(sessionId), lines, { encoding: "utf8", mode: 0o600 });
      entry.lastActiveAt = Date.now();
      await this.writeIndex(index);
    });
    if (this.activeId === sessionId) {
      this.activeMessages.push(...ownedMessages);
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
    return { id: entry.id, messages: [] };
  }

  private activate(session: AgentSession): AgentSession {
    this.activeId = session.id;
    this.activeMessages = cloneTranscriptMessages(session.messages);
    this.revision = 0;
    return { id: session.id, messages: cloneTranscriptMessages(this.activeMessages) };
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

  private async replay(sessionId: string): Promise<TranscriptMessage[]> {
    try {
      const messages: TranscriptMessage[] = [];
      for (const line of (await readFile(this.sessionPath(sessionId), "utf8")).split("\n")) {
        if (!line.trim()) continue;
        try {
          messages.push(JSON.parse(line) as TranscriptMessage);
        } catch {
          // Ignore a malformed partial line without discarding the valid session history.
        }
      }
      return messages;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
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
