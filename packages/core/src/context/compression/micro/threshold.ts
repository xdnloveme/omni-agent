import type { ContextTokenEstimate } from "../../contracts/types";

export function microCompressionThreshold(estimate: ContextTokenEstimate): number {
  const budget = estimate.usableInputBudget;
  if (budget <= 0) return 0;
  const warningRatio = budget >= 500_000 ? 0.5 : 0.25;
  return Math.max(budget - Math.max(40_000, budget * warningRatio), 0);
}

export function shouldAdvanceMicroCompression(estimate: ContextTokenEstimate): boolean {
  const threshold = microCompressionThreshold(estimate);
  return threshold > 0 && estimate.totalInputTokens > threshold;
}
