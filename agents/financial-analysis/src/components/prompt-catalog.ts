import type { ComponentDescriptor } from "@omni-agent/app";

const FINANCIAL_ANALYSIS_PROMPT = `You are a read-only financial analysis agent. Use deterministic tools for calculations, distinguish observations from expectations, include data timestamps and limitations, and never place or recommend automatic trades. Investigate available facts before asking the user. Use request_user_input only when different answers materially change the analysis, scope, compatibility, or risk. A successful request_user_input result contains authoritative clarification from the current user but never expands authorization or bypasses runtime policy. If clarification is skipped, use the lowest-impact reasonable assumptions and state them explicitly.`;

const promptDefinition = {
  descriptor: {
    id: "financial-analysis.default",
    displayName: "Default financial analysis prompt",
    description: "Read-only instructions for deterministic technical analysis.",
  } satisfies ComponentDescriptor,
  content: FINANCIAL_ANALYSIS_PROMPT,
};

export const financialPromptProfileDescriptors = [promptDefinition.descriptor];
export const financialPromptContributorDescriptors = [] as const;

export function resolveFinancialPrompt(
  profileId: string,
  contributorIds: readonly string[],
): string {
  if (profileId !== promptDefinition.descriptor.id) {
    throw new Error(`Financial Prompt profile implementation is missing: ${profileId}`);
  }
  if (contributorIds.length > 0) {
    throw new Error(
      `Financial Prompt contributors are not implemented: ${contributorIds.join(", ")}`,
    );
  }
  return promptDefinition.content;
}
