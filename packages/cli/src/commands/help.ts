import chalk from "chalk";

import type { Command, CommandRegistry } from "@omni-agent/core";

export function createHelpCommand(registry: CommandRegistry): Command {
  return {
    name: "help",
    description: "List all available commands",
    async execute(ctx) {
      ctx.tui.sink.line(chalk.bold("Available commands:"));
      for (const cmd of registry.list()) {
        ctx.tui.sink.line(`  ${chalk.cyan("/" + cmd.name)} — ${cmd.description}`);
      }
      ctx.tui.sink.spacer();
    },
  };
}
