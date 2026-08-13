import type { ContextCheckpoint } from "./types";

export interface ContextCheckpointStorePort {
  list(sessionId: string): Promise<readonly ContextCheckpoint[]>;
  append(checkpoint: ContextCheckpoint): Promise<void>;
}
