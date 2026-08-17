import type { TranscriptMessage } from "../messages";
import type { EnvironmentContextRecord } from "../environment";

export type SessionRecord =
  | { readonly kind: "message"; readonly message: TranscriptMessage }
  | { readonly kind: "environment"; readonly context: EnvironmentContextRecord };

export interface SessionSnapshot {
  readonly sessionId: string;
  readonly revision: number;
  readonly messages: readonly TranscriptMessage[];
  readonly environment?: EnvironmentContextRecord;
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
 * The Session index persisted at `<sessionsRoot>/<agentId>/index.json`.
 * The repository caller supplies `sessionsRoot`.
 */
export interface SessionIndex {
  sessions: SessionEntry[];
}
