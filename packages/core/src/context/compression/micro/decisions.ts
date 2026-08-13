import type { JsonValue } from "../../../data";
import type { ContextDecision, ContextTokenEstimate } from "../../contracts/types";

export type MicroDecisionStatus = "skipped" | "no_change" | "replayed" | "deferred" | "advanced";

export function microDecision(input: {
  readonly status: MicroDecisionStatus;
  readonly reason: string;
  readonly before: ContextTokenEstimate;
  readonly after: ContextTokenEstimate;
  readonly revision: number;
  readonly details?: Record<string, JsonValue>;
}): ContextDecision {
  return {
    type: `stable_micro_${input.status}`,
    details: {
      reason: input.reason,
      beforeTokens: input.before.totalInputTokens,
      afterTokens: input.after.totalInputTokens,
      projectionRevision: input.revision,
      ...input.details,
    },
  };
}
