export function resolveOutputBudget(input: {
  readonly contextWindow: number;
  readonly modelMaxOutputTokens: number;
  readonly requestedOutputTokens?: number;
}): {
  readonly modelMaxOutputTokens: number;
  readonly requestedOutputTokens: number;
} {
  const { contextWindow, modelMaxOutputTokens } = input;
  if (!Number.isInteger(contextWindow) || contextWindow <= 1) {
    throw new Error(`Invalid model context window: ${contextWindow}`);
  }
  if (!Number.isInteger(modelMaxOutputTokens) || modelMaxOutputTokens <= 0) {
    throw new Error(`Invalid model output limit: ${modelMaxOutputTokens}`);
  }
  const requestedOutputTokens =
    input.requestedOutputTokens ?? Math.min(modelMaxOutputTokens, contextWindow - 1);
  if (
    !Number.isInteger(requestedOutputTokens) ||
    requestedOutputTokens <= 0 ||
    requestedOutputTokens > modelMaxOutputTokens ||
    requestedOutputTokens >= contextWindow
  ) {
    throw new Error(`Invalid requested output budget: ${requestedOutputTokens}`);
  }
  return { modelMaxOutputTokens, requestedOutputTokens };
}
