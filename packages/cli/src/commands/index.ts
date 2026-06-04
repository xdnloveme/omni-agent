import { CommandRegistry } from "@omni-agent/core";
import { configCommand } from "./config.js";
import { createHelpCommand } from "./help.js";

export function createCommandRegistry(): CommandRegistry {
  const registry = new CommandRegistry();
  registry.register(configCommand);
  registry.register(createHelpCommand(registry));
  return registry;
}
