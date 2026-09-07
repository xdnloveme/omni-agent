import { isAbortError } from "../execution";
import { sanitizeSensitiveText } from "../security";
import type {
  PreparedToolBatch,
  ToolBatchPreparationContext,
  ToolBatchPreparationDecision,
  ToolBatchPreparationPolicy,
} from "./types";

/** Both Agent calls and command Hooks share ordered, fail-closed policy evaluation. */
export async function evaluateToolBatchPolicies(
  policies: readonly ToolBatchPreparationPolicy[],
  batch: PreparedToolBatch,
  context: ToolBatchPreparationContext,
): Promise<ToolBatchPreparationDecision> {
  try {
    for (const policy of policies) {
      const decision = await policy.evaluate(batch, context);
      if (decision.kind !== "executable") return decision;
    }
    return { kind: "executable" };
  } catch (error) {
    if (isAbortError(error)) throw error;
    return {
      kind: "failed",
      code:
        error && typeof error === "object" && "code" in error && typeof error.code === "string"
          ? error.code
          : "tool_batch_preparation_failed",
      message: sanitizeSensitiveText(error instanceof Error ? error.message : String(error)),
    };
  }
}
