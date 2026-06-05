import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { SessionMessage, SessionEntry, SessionIndex } from "./types.js";

const SESSIONS_DIR = join(homedir(), ".omni-agent", "sessions");
const INDEX_FILE = join(SESSIONS_DIR, "index.json");

/**
 * Ensure the sessions directory exists.
 */
function ensureDir(): void {
  if (!existsSync(SESSIONS_DIR)) {
    mkdirSync(SESSIONS_DIR, { recursive: true });
  }
}

/**
 * Get the JSONL file path for a given session ID.
 */
function sessionPath(id: string): string {
  return join(SESSIONS_DIR, `${id}.jsonl`);
}

/**
 * Read the session index. Returns an empty index if the file doesn't exist.
 */
export function readIndex(): SessionIndex {
  ensureDir();
  if (!existsSync(INDEX_FILE)) {
    return { sessions: [] };
  }
  try {
    const raw = readFileSync(INDEX_FILE, "utf-8");
    const parsed = JSON.parse(raw) as SessionIndex;
    if (!Array.isArray(parsed.sessions)) {
      return { sessions: [] };
    }
    return parsed;
  } catch {
    return { sessions: [] };
  }
}

/**
 * Write the session index atomically.
 */
export function writeIndex(index: SessionIndex): void {
  ensureDir();
  writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2) + "\n", "utf-8");
}

/**
 * Add or update a session entry in the index.
 */
export function upsertIndexEntry(entry: SessionEntry): void {
  const index = readIndex();
  const existing = index.sessions.findIndex((s) => s.id === entry.id);
  if (existing >= 0) {
    index.sessions[existing] = entry;
  } else {
    index.sessions.push(entry);
  }
  writeIndex(index);
}

/**
 * Append a message to a session's JSONL file and update lastActiveAt.
 */
export function appendMessage(sessionId: string, message: SessionMessage): void {
  ensureDir();
  const filePath = sessionPath(sessionId);
  const line = JSON.stringify(message) + "\n";
  appendFileSync(filePath, line, "utf-8");

  // Update lastActiveAt in index
  const index = readIndex();
  const entry = index.sessions.find((s) => s.id === sessionId);
  if (entry) {
    entry.lastActiveAt = Date.now();
    writeIndex(index);
  }
}

/**
 * Append multiple messages to a session's JSONL file in one batch.
 */
export function appendMessages(sessionId: string, messages: SessionMessage[]): void {
  if (messages.length === 0) return;
  ensureDir();
  const filePath = sessionPath(sessionId);
  const lines = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
  appendFileSync(filePath, lines, "utf-8");

  // Update lastActiveAt in index
  const index = readIndex();
  const entry = index.sessions.find((s) => s.id === sessionId);
  if (entry) {
    entry.lastActiveAt = Date.now();
    writeIndex(index);
  }
}

/**
 * Replay all messages from a session's JSONL file.
 * Returns an empty array if the file doesn't exist or is corrupted.
 */
export function replayMessages(sessionId: string): SessionMessage[] {
  const filePath = sessionPath(sessionId);
  if (!existsSync(filePath)) {
    return [];
  }

  const raw = readFileSync(filePath, "utf-8");
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  const messages: SessionMessage[] = [];

  for (const line of lines) {
    try {
      messages.push(JSON.parse(line) as SessionMessage);
    } catch {
      // Skip malformed lines — resilient to partial writes
    }
  }

  return messages;
}

/**
 * Clear a session's JSONL file (truncate to empty).
 */
export function clearSession(sessionId: string): void {
  const filePath = sessionPath(sessionId);
  if (existsSync(filePath)) {
    writeFileSync(filePath, "", "utf-8");
  }
}

/**
 * Remove a session entirely (JSONL file + index entry).
 */
export function removeSession(sessionId: string): void {
  const filePath = sessionPath(sessionId);
  if (existsSync(filePath)) {
    unlinkSync(filePath);
  }
  const index = readIndex();
  index.sessions = index.sessions.filter((s) => s.id !== sessionId);
  writeIndex(index);
}
