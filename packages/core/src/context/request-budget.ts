import type { ContextModelLimits } from "./contracts/types";

export const REQUEST_BUDGET_POLICY_VERSION = 1;
const INPUT_ESTIMATE_MARGIN_RATIO = 0.05;

export function inputBudget(contextWindow: number): number {
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 1)
    throw new Error("Invalid model context window");
  // This proportional margin covers estimation uncertainty; it is not an output ceiling.
  return contextWindow - Math.ceil(contextWindow * INPUT_ESTIMATE_MARGIN_RATIO);
}

export function requestOutputBudget(model: ContextModelLimits, inputTokens: number): number {
  if (!Number.isFinite(inputTokens) || inputTokens < 0)
    throw new Error("Invalid estimated input tokens");
  const output = Math.min(
    model.modelMaxOutputTokens,
    model.requestedOutputTokens,
    inputBudget(model.contextWindow) - Math.ceil(inputTokens),
  );
  if (!Number.isSafeInteger(output) || output < 1)
    throw new Error("Context leaves no valid output budget after compression");
  return output;
}
