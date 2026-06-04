import { BASE_SYSTEM_PROMPT } from "./base.js";
import { defaultContributors, type SystemPromptContributor } from "./contributors.js";

/**
 * Compose the final system prompt from the base template and dynamic contributors.
 */
export async function composeSystemPrompt(
  cwd: string,
  contributors: SystemPromptContributor[] = defaultContributors,
): Promise<string> {
  const sections: string[] = [BASE_SYSTEM_PROMPT.trim()];

  const results = await Promise.all(contributors.map((c) => c(cwd)));
  for (const section of results) {
    if (section) {
      sections.push(section);
    }
  }

  return sections.join("\n\n");
}
