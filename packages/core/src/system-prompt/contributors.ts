import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SkillRegistry } from "../skills";
import { assertPromptContributionBudget, PROMPT_CONTRIBUTION_BUDGETS } from "../promptBudget";
import { escapeMarkupText } from "../markup";

/**
 * A SystemPromptContributor returns a section string (or null to skip).
 */
export type SystemPromptContributor = (cwd: string) => Promise<string | null>;

/**
 * Reads AGENTS.md from the working directory (if it exists) and injects it as project rules.
 */
export const agentsMdContributor: SystemPromptContributor = async (cwd) => {
  const filePath = join(cwd, "AGENTS.md");
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
  if (!content.trim()) return null;
  const section = [
    "# Project Rules",
    "",
    '<project_rules source="AGENTS.md" scope="workspace">',
    escapeMarkupText(content.trim()),
    "</project_rules>",
  ].join("\n");
  assertPromptContributionBudget(
    "project rules",
    section,
    PROMPT_CONTRIBUTION_BUDGETS.projectRules,
  );
  return section;
};

export function createSkillsContributor(registry: SkillRegistry): SystemPromptContributor {
  return async () => {
    const prompt = registry.renderPromptIndex();
    if (!prompt.trim()) return null;
    assertPromptContributionBudget("skill index", prompt, PROMPT_CONTRIBUTION_BUDGETS.skillIndex);
    return prompt;
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
