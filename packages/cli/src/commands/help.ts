import type { Command, CommandRegistry } from "@omni-agent/core";
import type { TextPresentationPort } from "../host-services";

export function createHelpCommand(registry: CommandRegistry, text: TextPresentationPort): Command {
  return {
    name: "help",
    description: "List all available commands",
    async execute(ctx) {
      ctx.interaction.line(text.heading("Available commands:"));
      for (const cmd of registry.list()) {
        ctx.interaction.line(`  ${text.accent("/" + cmd.name)} — ${cmd.description}`);
      }
      ctx.interaction.spacer();
    },
  };
}
