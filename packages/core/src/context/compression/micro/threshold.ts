import type { ContextTokenEstimate } from "../../contracts/types";

export const MICRO_THRESHOLD_POLICY_VERSION = 2;
export const MICRO_HEADROOM_MINIMUM_TOKENS = 8_000;
export const MICRO_HEADROOM_RATIO = 0.05;

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

export function microCompressionHeadroom(estimate: ContextTokenEstimate): number {
  return Math.max(MICRO_HEADROOM_MINIMUM_TOKENS, estimate.usableInputBudget * MICRO_HEADROOM_RATIO);
}

export function microCompressionTarget(estimate: ContextTokenEstimate): number {
  // Keep a stable margin below the admission threshold so small appends do not
  // trigger another prefix rewrite on the next model call.
  return Math.max(microCompressionThreshold(estimate) - microCompressionHeadroom(estimate), 0);
}
