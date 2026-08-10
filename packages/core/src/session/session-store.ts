import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { SessionEntry, SessionIndex, SessionMessage } from "./types";

export interface SessionStore {
  readIndex(): SessionIndex;
  writeIndex(index: SessionIndex): void;
  upsertIndexEntry(entry: SessionEntry): void;
  appendMessage(sessionId: string, message: SessionMessage): void;
  appendMessages(sessionId: string, messages: SessionMessage[]): void;
  replayMessages(sessionId: string): SessionMessage[];
  clearSession(sessionId: string): void;
  removeSession(sessionId: string): void;
}

export class FileSessionStore implements SessionStore {
  private readonly indexFile: string;

  constructor(private readonly directory = join(homedir(), ".omni-agent", "sessions")) {
    this.indexFile = join(directory, "index.json");
  }

  readIndex(): SessionIndex {
    this.ensureDirectory();
    if (!existsSync(this.indexFile)) return { sessions: [] };

    try {
      const parsed = JSON.parse(readFileSync(this.indexFile, "utf8")) as SessionIndex;
      return Array.isArray(parsed.sessions) ? parsed : { sessions: [] };
    } catch {
      return { sessions: [] };
    }
  }

  writeIndex(index: SessionIndex): void {
    this.ensureDirectory();
    writeFileSync(this.indexFile, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  }

  upsertIndexEntry(entry: SessionEntry): void {
    const index = this.readIndex();
    const existing = index.sessions.findIndex((session) => session.id === entry.id);
    if (existing >= 0) index.sessions[existing] = entry;
    else index.sessions.push(entry);
    this.writeIndex(index);
  }

  appendMessage(sessionId: string, message: SessionMessage): void {
    this.ensureDirectory();
    appendFileSync(this.sessionPath(sessionId), `${JSON.stringify(message)}\n`, "utf8");
    this.touch(sessionId);
  }

  appendMessages(sessionId: string, messages: SessionMessage[]): void {
    if (messages.length === 0) return;
    this.ensureDirectory();
    const lines = `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`;
    appendFileSync(this.sessionPath(sessionId), lines, "utf8");
    this.touch(sessionId);
  }

  replayMessages(sessionId: string): SessionMessage[] {
    const path = this.sessionPath(sessionId);
    if (!existsSync(path)) return [];

    const messages: SessionMessage[] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        messages.push(JSON.parse(line) as SessionMessage);
      } catch {
        // A partial final write must not make the whole session unreadable.
      }
    }
    return messages;
  }

  clearSession(sessionId: string): void {
    const path = this.sessionPath(sessionId);
    if (existsSync(path)) writeFileSync(path, "", "utf8");
  }

  removeSession(sessionId: string): void {
    const path = this.sessionPath(sessionId);
    if (existsSync(path)) unlinkSync(path);
    const index = this.readIndex();
    index.sessions = index.sessions.filter((session) => session.id !== sessionId);
    this.writeIndex(index);
  }

  private ensureDirectory(): void {
    if (!existsSync(this.directory)) mkdirSync(this.directory, { recursive: true });
  }

  private sessionPath(sessionId: string): string {
    return join(this.directory, `${sessionId}.jsonl`);
  }

  private touch(sessionId: string): void {
    const index = this.readIndex();
    const entry = index.sessions.find((session) => session.id === sessionId);
    if (!entry) return;
    entry.lastActiveAt = Date.now();
    this.writeIndex(index);
  }
}
