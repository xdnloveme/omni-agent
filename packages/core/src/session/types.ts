import type { TranscriptMessage } from "../messages";

export interface SessionTranscriptSnapshot {
  readonly sessionId: string;
  readonly revision: number;
  readonly messages: readonly TranscriptMessage[];
}

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
