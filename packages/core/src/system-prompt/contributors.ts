import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SkillRegistry } from "../skills";

/**
 * A SystemPromptContributor returns a section string (or null to skip).
 */
export type SystemPromptContributor = (cwd: string) => Promise<string | null>;

/**
 * Injects the current working directory as context.
 */
export const cwdContributor: SystemPromptContributor = async (cwd) => {
  return `# Environment\n\nCurrent working directory: ${cwd}`;
};

/**
 * Reads AGENTS.md from the working directory (if it exists) and injects it as project rules.
 */
export const agentsMdContributor: SystemPromptContributor = async (cwd) => {
  const filePath = join(cwd, "AGENTS.md");
  try {
    const content = await readFile(filePath, "utf-8");
    if (!content.trim()) return null;
    return `# Project Rules (from AGENTS.md)\n\n${content.trim()}`;
  } catch {
    return null;
  }
};

export const defaultContributors: SystemPromptContributor[] = [
  cwdContributor,
  agentsMdContributor,
];

export function createSkillsContributor(registry: SkillRegistry): SystemPromptContributor {
  return async () => {
    const prompt = registry.renderPromptIndex();
    return prompt.trim() ? prompt : null;
  };
}
