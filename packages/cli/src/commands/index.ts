import { CommandRegistry } from "@omni-agent/core";
import { configCommand } from "./config";
import { createHelpCommand } from "./help";

export function createCommandRegistry(): CommandRegistry {
  const registry = new CommandRegistry();
  registry.register(configCommand);
  registry.register(createHelpCommand(registry));
  return registry;
}
