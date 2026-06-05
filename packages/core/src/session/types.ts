import type { Message } from "@mariozechner/pi-ai";

/**
 * Re-export the LLM Message type as SessionMessage for clarity.
 * The session stores messages in the exact format the LLM API expects.
 */
export type SessionMessage = Message;

/**
 * Metadata for a single session in the index.
 */
export interface SessionEntry {
  id: string;
  createdAt: number;
  lastActiveAt: number;
}

/**
 * The index file structure stored at ~/.omni-agent/sessions/index.json
 */
export interface SessionIndex {
  sessions: SessionEntry[];
}
