import type { ContextEntry } from "../contracts/types";
import type { ContextTokenEstimatorPort } from "../contracts/ports";

export interface ContextPartition {
  readonly coveredMessageCount: number;
  readonly coveredEntries: readonly ContextEntry[];
  readonly tailEntries: readonly ContextEntry[];
}

export function partitionContextEntries(
  entries: readonly ContextEntry[],
  tailTokenBudget: number,
  estimator: ContextTokenEstimatorPort,
  minimumCoveredMessageCount?: number,
): ContextPartition {
  const sourceEntries = entries.filter(
    (entry): entry is Exclude<ContextEntry, { kind: "checkpoint" }> => entry.kind !== "checkpoint",
  );
  const groups = groupEntries(sourceEntries);
  const tailGroups: Exclude<ContextEntry, { kind: "checkpoint" }>[][] = [];
  let used = 0;
  for (let index = groups.length - 1; index >= 0; index--) {
    const group = groups[index];
    const firstSourceIndex = group[0]?.sourceIndex ?? 0;
    if (
      minimumCoveredMessageCount !== undefined &&
      firstSourceIndex <= minimumCoveredMessageCount
    ) {
      break;
    }
    const cost = group.reduce((total, entry) => total + estimator.estimateEntry(entry), 0);
    if (used + cost > tailTokenBudget) break;
    tailGroups.unshift(group);
    used += cost;
  }
  const tailEntries = tailGroups.flat();
  const checkpointCoverage = entries.reduce(
    (maximum, entry) =>
      entry.kind === "checkpoint" ? Math.max(maximum, entry.coveredMessageCount) : maximum,
    0,
  );
  const coveredMessageCount = tailEntries.length
    ? Math.min(...tailEntries.map((entry) => entry.sourceIndex))
    : sourceEntries.reduce(
        (max, entry) => Math.max(max, entry.sourceIndex + 1),
        checkpointCoverage,
      );
  return {
    coveredMessageCount,
    coveredEntries: entries.filter(
      (entry) => entry.kind === "checkpoint" || entry.sourceIndex < coveredMessageCount,
    ),
    tailEntries,
  };
}

function groupEntries(
  entries: readonly Exclude<ContextEntry, { kind: "checkpoint" }>[],
): Exclude<ContextEntry, { kind: "checkpoint" }>[][] {
  const groups: Exclude<ContextEntry, { kind: "checkpoint" }>[][] = [];
  for (const entry of entries) {
    const isUser = entry.kind === "transcript" && entry.message.role === "user";
    if (isUser || groups.length === 0) groups.push([]);
    groups[groups.length - 1].push(entry);
  }
  return groups;
}
