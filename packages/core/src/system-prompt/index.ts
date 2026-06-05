import { composeSystemPrompt } from "./compose";

export { BASE_SYSTEM_PROMPT } from "./base";
export { composeSystemPrompt } from "./compose";
export {
  cwdContributor,
  agentsMdContributor,
  defaultContributors,
  type SystemPromptContributor,
} from "./contributors";

/**
 * Build the full system prompt for the given working directory.
 * This is the main entry point for consumers.
 */
export async function buildSystemPrompt(cwd: string): Promise<string> {
  return composeSystemPrompt(cwd);
}
