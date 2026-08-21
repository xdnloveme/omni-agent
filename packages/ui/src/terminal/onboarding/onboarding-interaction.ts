import { confirm, input, password, select } from "@inquirer/prompts";
import chalk from "chalk";
import { createAuthInteraction } from "./auth-interaction";

interface Option {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

export function confirmTerminalAction(message: string): Promise<boolean> {
  return confirm({ message, default: false });
}

export function createOnboardingInteraction() {
  const choose = (message: string, options: readonly Option[], loop: boolean) =>
    select({
      message,
      choices: options.map((option) => ({
        name: option.label,
        value: option.id,
        description: option.description,
      })),
      loop,
    });

  return {
    showWelcome() {
      console.log();
      console.log(chalk.bold("  Welcome to omni-agent"));
      console.log(chalk.dim("  Let's set up your model provider.\n"));
    },
    selectProvider: (options: readonly Option[]) =>
      choose("Select your model provider", options, false),
    selectAuthenticationMethod: (options: readonly Option[]) =>
      choose("Select an authentication method", options, true),
    selectModel: (options: readonly Option[], message = "Select your model") =>
      choose(message, options, false),
    select: (message: string, options: readonly Option[], behavior: { readonly loop: boolean }) =>
      choose(message, options, behavior.loop),
    input(options: {
      readonly message: string;
      readonly defaultValue?: string;
      readonly secret?: boolean;
      readonly validate?: (value: string) => true | string;
    }) {
      const promptOptions = {
        message: options.message,
        default: options.defaultValue,
        validate: options.validate,
      };
      return options.secret
        ? password({ message: options.message, mask: "*", validate: options.validate })
        : input(promptOptions);
    },
    createAuthInteraction,
    showConfigurationReady(summary: { provider: string; model: string; credential: string }) {
      console.log();
      console.log(chalk.green("  ✓ Configuration ready."));
      console.log(chalk.dim(`    Provider: ${summary.provider}`));
      console.log(chalk.dim(`    Model: ${summary.model}`));
      console.log(chalk.dim(`    Credential: ${summary.credential}`));
      console.log();
    },
  };
}
