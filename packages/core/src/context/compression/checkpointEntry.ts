import type { ContextCheckpoint } from "../checkpoints/types";
import type { ContextEntry, ContextHistoryFrame } from "../contracts/types";

export function restoreCheckpoint(
  frame: ContextHistoryFrame,
  checkpoint: ContextCheckpoint,
): ContextHistoryFrame {
  const tail = frame.entries.filter(
    (entry) => entry.kind !== "checkpoint" && entry.sourceIndex >= checkpoint.coveredMessageCount,
  );
  return {
    entries: [toCheckpointEntry(checkpoint), ...tail],
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
