import type { SkillRegistry } from "../skills";
import { assertPromptContributionBudget, PROMPT_CONTRIBUTION_BUDGETS } from "../promptBudget";

/**
 * A SystemPromptContributor returns a section string (or null to skip).
 */
export type SystemPromptContributor = (cwd: string) => Promise<string | null>;

export function createSkillsContributor(registry: SkillRegistry): SystemPromptContributor {
  return async () => {
    const prompt = registry.renderPromptIndex();
    if (!prompt.trim()) return null;
    assertPromptContributionBudget("skill index", prompt, PROMPT_CONTRIBUTION_BUDGETS.skillIndex);
    return prompt;
  };
}
