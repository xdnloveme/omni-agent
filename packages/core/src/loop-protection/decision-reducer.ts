import type { BatchCycleEvaluation, LoopDecision } from "./types";

export function reduceLoopDecisions(
  decisions: readonly LoopDecision[],
  batchEvaluation?: BatchCycleEvaluation,
): LoopDecision {
  const candidates = batchEvaluation?.activeCycle
    ? decisions.filter(
        (decision) => decision.type === "continue" || decision.source !== "repeated_result",
      )
    : [...decisions];
  if (batchEvaluation) candidates.push(batchEvaluation.decision);

  return candidates.reduce<LoopDecision>(
    (current, candidate) => (decisionRank(candidate) > decisionRank(current) ? candidate : current),
    { type: "continue" },
  );
}

function decisionRank(decision: LoopDecision): number {
  if (decision.type === "halt") return 400 + sourceRank(decision.source);
  if (decision.type === "continue") return 0;
  const severity = decision.severity === "strong" ? 300 : 200;
  return severity + sourceRank(decision.source);
}

function sourceRank(source: Exclude<LoopDecision, { type: "continue" }>["source"]): number {
  if (source === "repeated_batch" || source === "alternating_batch") return 3;
  if (source === "repeated_error") return 2;
  return 1;
}
