import { randomUUID } from "node:crypto";

import type { SessionMessage, SessionEntry } from "./types";
import { FileSessionStore, type SessionStore } from "./session-store";

/**
 * SessionManager — manages the lifecycle of conversation sessions.
 *
 * Responsibilities:
 * - Create new sessions
 * - Restore the most recent session
 * - Switch between sessions
 * - Append messages (single or batch)
 * - Clear current session history
 */
export class SessionManager {
  private _currentId: string | null = null;
  private _messages: SessionMessage[] = [];

  constructor(private readonly store: SessionStore = new FileSessionStore()) {}

  /** The current session ID, or null if no session is active. */
  get currentId(): string | null {
    return this._currentId;
  }

  /** The in-memory messages for the current session. */
  get messages(): ReadonlyArray<SessionMessage> {
    return this._messages;
  }

  /**
   * Create a new session and switch to it.
   * Returns the new session ID.
   */
  create(): string {
    const id = randomUUID();
    const now = Date.now();
    const entry: SessionEntry = {
      id,
      createdAt: now,
      lastActiveAt: now,
    };
    this.store.upsertIndexEntry(entry);
    this._currentId = id;
    this._messages = [];
    return id;
  }

  /**
   * Restore the most recent session (by lastActiveAt).
   * If no sessions exist, creates a new one.
   * Returns the session ID.
   */
  restoreLatest(): string {
    const index = this.store.readIndex();
    if (index.sessions.length === 0) {
      return this.create();
    }

    // Sort by lastActiveAt descending
    const sorted = [...index.sessions].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    const latest = sorted[0];

    this._currentId = latest.id;
    this._messages = this.store.replayMessages(latest.id);
    return latest.id;
  }

  /**
   * Switch to an existing session by ID.
   * Throws if the session doesn't exist in the index.
   */
  switchTo(sessionId: string): void {
    const index = this.store.readIndex();
    const entry = index.sessions.find((s) => s.id === sessionId);
    if (!entry) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    this._currentId = sessionId;
    this._messages = this.store.replayMessages(sessionId);
  }

  /**
   * Append a single message to the current session (memory + disk).
   */
  append(message: SessionMessage): void {
    if (!this._currentId) {
      throw new Error("No active session. Call create() or restoreLatest() first.");
    }
    this._messages.push(message);
    this.store.appendMessage(this._currentId, message);
  }

  /**
   * Append multiple messages to the current session (memory + disk).
   */
  appendBatch(messages: SessionMessage[]): void {
    if (!this._currentId) {
      throw new Error("No active session. Call create() or restoreLatest() first.");
    }
    this._messages.push(...messages);
    this.store.appendMessages(this._currentId, messages);
  }

  /**
   * Clear the current session's history (memory + disk).
   * The session entry remains in the index.
   */
  clear(): void {
    if (!this._currentId) {
      throw new Error("No active session. Call create() or restoreLatest() first.");
    }
    this._messages = [];
    this.store.clearSession(this._currentId);
  }
}
