import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";

import type { SessionEntry, SessionIndex, SessionMessage } from "./types";

const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;

export interface AgentSession {
  readonly id: string;
  readonly messages: readonly SessionMessage[];
}

export interface AgentSessionRepositoryOptions {
  readonly agentId: string;
  readonly sessionsRoot: string;
}

export class AgentSessionRepository {
  private readonly directory: string;
  private readonly indexPath: string;
  private readonly lockPath: string;
  private activeId: string | null = null;
  private activeMessages: SessionMessage[] = [];

  constructor(options: AgentSessionRepositoryOptions) {
    assertAgentId(options.agentId);
    this.directory = join(options.sessionsRoot, options.agentId);
    this.indexPath = join(this.directory, "index.json");
    this.lockPath = join(this.directory, ".lock");
  }

  get currentId(): string | null {
    return this.activeId;
  }

  get messages(): readonly SessionMessage[] {
    return this.activeMessages;
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

  async append(sessionId: string, messages: readonly SessionMessage[]): Promise<void> {
    if (messages.length === 0) return;
    assertSessionId(sessionId);
    await this.exclusive(async () => {
      const index = await this.readIndex();
      const entry = index.sessions.find((candidate) => candidate.id === sessionId);
      if (!entry) throw new Error(`Session not found: ${sessionId}`);

      const lines = `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`;
      await appendFile(this.sessionPath(sessionId), lines, { encoding: "utf8", mode: 0o600 });
      entry.lastActiveAt = Date.now();
      await this.writeIndex(index);
    });
    if (this.activeId === sessionId) this.activeMessages.push(...messages);
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
    if (this.activeId === sessionId) this.activeMessages = [];
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
    this.activeMessages = [...session.messages];
    return { id: session.id, messages: this.activeMessages };
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

  private async replay(sessionId: string): Promise<SessionMessage[]> {
    try {
      const messages: SessionMessage[] = [];
      for (const line of (await readFile(this.sessionPath(sessionId), "utf8")).split("\n")) {
        if (!line.trim()) continue;
        try {
          messages.push(JSON.parse(line) as SessionMessage);
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
    const lock = await this.acquireLock();
    let result: T | undefined;
    let operationError: unknown;
    try {
      result = await operation();
    } catch (error) {
      operationError = error;
    }

    let cleanupError: unknown;
    try {
      await lock.close();
      await unlink(this.lockPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    } catch (error) {
      cleanupError = error;
    }

    if (operationError && cleanupError) {
      throw new AggregateError(
        [operationError, cleanupError],
        `Session operation and lock cleanup failed: ${this.directory}`,
      );
    }
    if (operationError) throw operationError;
    if (cleanupError) throw cleanupError;
    return result as T;
  }

  private async acquireLock(): Promise<FileHandle> {
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    while (true) {
      try {
        const handle = await open(this.lockPath, "wx", 0o600);
        try {
          await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
          return handle;
        } catch (error) {
          await handle.close();
          await unlink(this.lockPath).catch(() => undefined);
          throw error;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await this.removeStaleLock();
        if (Date.now() >= deadline) throw new Error(`Session lock timeout: ${this.directory}`);
        await delay(LOCK_RETRY_MS);
      }
    }
  }

  private async removeStaleLock(): Promise<void> {
    let metadata: { pid?: unknown; createdAt?: unknown } = {};
    try {
      metadata = JSON.parse(await readFile(this.lockPath, "utf8")) as typeof metadata;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    }
    try {
      const lockStat = await stat(this.lockPath);
      const createdAt =
        typeof metadata.createdAt === "number" ? metadata.createdAt : lockStat.mtimeMs;
      if (Date.now() - createdAt < STALE_LOCK_MS) return;
      if (typeof metadata.pid === "number" && isProcessAlive(metadata.pid)) return;
      await unlink(this.lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private sessionPath(sessionId: string): string {
    return join(this.directory, `${sessionId}.jsonl`);
  }
}

function assertAgentId(agentId: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(agentId)) {
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

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
