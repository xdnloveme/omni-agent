import { CommandRegistry } from "@omni-agent/core";
import type { AgentApplication } from "@omni-agent/app";
import { createConfigCommand } from "./config";
import { createHelpCommand } from "./help";

export function createCommandRegistry(app: AgentApplication): CommandRegistry {
  const registry = new CommandRegistry();
  registry.register(createConfigCommand(app));
  registry.register(createHelpCommand(registry));
  return registry;
}
