import type { ContextCheckpoint } from "../checkpoints/types";
import type { ContextEntry, ContextFrame } from "../contracts/types";

export function restoreCheckpoint(
  frame: ContextFrame,
  checkpoint: ContextCheckpoint,
): ContextFrame {
  return {
    ...frame,
    entries: [
      toCheckpointEntry(checkpoint),
      ...frame.entries.filter(
        (entry) =>
          entry.kind !== "checkpoint" && entry.sourceIndex >= checkpoint.coveredMessageCount,
      ),
    ],
  };
}

export function toCheckpointEntry(checkpoint: ContextCheckpoint): ContextEntry {
  return {
    kind: "checkpoint",
    checkpointId: checkpoint.id,
    parentId: checkpoint.parentId,
    coveredMessageCount: checkpoint.coveredMessageCount,
    promptVersion: checkpoint.promptVersion,
    summary: checkpoint.summary,
    summaryModelCallId: checkpoint.summaryModelCallId,
  };
}
