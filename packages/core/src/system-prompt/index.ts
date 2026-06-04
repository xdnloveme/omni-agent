import { composeSystemPrompt } from "./compose.js";

export { BASE_SYSTEM_PROMPT } from "./base.js";
export { composeSystemPrompt } from "./compose.js";
export {
  cwdContributor,
  agentsMdContributor,
  defaultContributors,
  type SystemPromptContributor,
} from "./contributors.js";

/**
 * Build the full system prompt for the given working directory.
 * This is the main entry point for consumers.
 */
export async function buildSystemPrompt(cwd: string): Promise<string> {
  return composeSystemPrompt(cwd);
}
