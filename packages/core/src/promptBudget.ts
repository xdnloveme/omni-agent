import { estimateContextTextTokens } from "./tokenEstimate";

export const PROMPT_CONTRIBUTION_BUDGETS = Object.freeze({
  environmentContext: 2_048,
  projectRules: 24_000,
  skillIndex: 16_000,
  skillBody: 32_000,
  stableSystemPrompt: 48_000,
} as const);

export class PromptContributionBudgetError extends Error {
  constructor(
    readonly contribution: string,
    readonly estimatedTokens: number,
    readonly maxTokens: number,
  ) {
    super(
      `Prompt contribution "${contribution}" is estimated at ${estimatedTokens} tokens, exceeding its ${maxTokens}-token limit`,
    );
    this.name = "PromptContributionBudgetError";
  }
}

export function assertPromptContributionBudget(
  contribution: string,
  content: string,
  maxTokens: number,
): void {
  const estimatedTokens = estimateContextTextTokens(content);
  if (estimatedTokens > maxTokens) {
    throw new PromptContributionBudgetError(contribution, estimatedTokens, maxTokens);
  }
}

export function composeStableSystemPrompt(
  basePrompt: string,
  contributions: readonly (string | null)[],
): string {
  const prompt = [basePrompt.trim(), ...contributions.filter((value): value is string => !!value)]
    .map((section) => section.trim())
    .filter(Boolean)
    .join("\n\n");
  assertPromptContributionBudget(
    "stable system prompt",
    prompt,
    PROMPT_CONTRIBUTION_BUDGETS.stableSystemPrompt,
  );
  return prompt;
}
