import { cloneData } from "../dataCopy";
import { isAbortError } from "../execution";
import { sanitizeSensitiveText } from "../security";
import type {
  PreparedToolBatch,
  PreparedToolCall,
  ValidatedToolResult,
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
      if (decision.kind === "failed" && decision.source.kind === "calls") {
        const ids = decision.source.toolCallIds;
        if (
          ids.length === 0 ||
          new Set(ids).size !== ids.length ||
          ids.some(
            (id) =>
              !batch.calls.some((call) => call.toolCallId === id && call.preparation === "ready"),
          )
        ) {
          throw new Error(
            "Batch policy failure must identify distinct prepared calls from this batch",
          );
        }
      }
      if (decision.kind !== "executable") return decision;
    }
    return { kind: "executable" };
  } catch (error) {
    if (isAbortError(error)) throw error;
    return {
      kind: "failed",
      source: { kind: "batch" },
      code:
        error && typeof error === "object" && "code" in error && typeof error.code === "string"
          ? error.code
          : "tool_batch_preparation_failed",
      message: sanitizeSensitiveText(error instanceof Error ? error.message : String(error)),
    };
  }
}

/** Preserve the originating error; siblings receive a batch-blocked result, never a false local fault. */
export function failedBatchToolResult(
  decision: Extract<ToolBatchPreparationDecision, { kind: "failed" }>,
  call: Pick<PreparedToolCall, "toolCallId">,
): ValidatedToolResult {
  const source = cloneData(decision.source);
  const blockedBy =
    source.kind === "calls" && !source.toolCallIds.includes(call.toolCallId)
      ? source.toolCallIds
      : undefined;
  const details = {
    code: blockedBy ? "tool_batch_blocked" : decision.code,
    retryable: false,
    executed: false,
    source,
    ...(blockedBy ? { cause: { code: decision.code, message: decision.message } } : {}),
  };
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: blockedBy
          ? `This call was not executed because other calls in the same batch failed preparation: ${blockedBy.join(", ")}. Resolve those failures and reissue this call if still needed.`
          : decision.message,
      },
    ],
    meta: details,
    transcriptDetails: details,
  };
}
