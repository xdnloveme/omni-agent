import { input, password, select } from "@inquirer/prompts";
import chalk from "chalk";
import type { ModelAuthInteraction } from "@omni-agent/app";
import { normalizePromptResult } from "./prompt-result";

export function createAuthInteraction(signal?: AbortSignal): ModelAuthInteraction {
  return {
    signal,
    async prompt(prompt) {
      const context = { signal: prompt.signal ?? signal };
      if (prompt.type === "select") {
        return normalizePromptResult(
          select(
            {
              message: prompt.message,
              choices: prompt.options.map((option) => ({
                name: option.label,
                value: option.id,
                description: option.description,
              })),
            },
            context,
          ),
        );
      }
      if (prompt.type === "secret") {
        return normalizePromptResult(password({ message: prompt.message, mask: "*" }, context));
      }
      return normalizePromptResult(
        input(
          {
            message: prompt.message,
            default: prompt.placeholder,
          },
          context,
        ),
      );
    },
    notify(event) {
      if (event.type === "auth_url") {
        console.log(chalk.cyan(event.instructions ?? "Open this URL to continue authentication:"));
        console.log(event.url);
        return;
      }
      if (event.type === "device_code") {
        console.log(chalk.cyan(`Open ${event.verificationUri} and enter code ${event.userCode}`));
        return;
      }
      console.log(chalk.dim(event.message));
      for (const link of event.links ?? [])
        console.log(`${link.label ?? "More information"}: ${link.url}`);
    },
  };
}
