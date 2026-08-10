import type { AgentMessage } from "../models/messages";

/**
 * Session-facing name for the stable agent message wire format.
 */
export type SessionMessage = AgentMessage;

/**
 * Metadata for a single session in the index.
 */
export interface SessionEntry {
  id: string;
  createdAt: number;
  lastActiveAt: number;
}

/**
 * The index file structure stored at ~/.omni-agent/sessions/<agent-id>/index.json.
 */
export interface SessionIndex {
  sessions: SessionEntry[];
}
