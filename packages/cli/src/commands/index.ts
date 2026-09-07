import { CommandRegistry } from "@omni-agent/core";
import type { AgentApplication } from "@omni-agent/app";
import type { AgentTraceControlCapability } from "@omni-agent/app";
import { createConfigCommand } from "./config";
import { createHelpCommand } from "./help";
import { createPermissionsCommand } from "./permissions";
import { createTraceCommand } from "./trace";
import { createMcpCommand } from "./mcp";
import type { CliHostServices } from "../host-services";

export const HOST_COMMAND_NAMES = [
  "config",
  "permissions",
  "help",
  "new",
  "clear",
  "skills",
  "trace",
  "mcp",
] as const;

export function createCommandRegistry(
  app: AgentApplication,
  host: Pick<CliHostServices, "createOnboardingInteraction" | "text">,
  trace?: AgentTraceControlCapability,
): CommandRegistry {
  const registry = new CommandRegistry();
  registry.register(createConfigCommand(app, host.createOnboardingInteraction, host.text));
  registry.register(createPermissionsCommand(app, host.text));
  registry.register(createMcpCommand(app));
  if (trace) registry.register(createTraceCommand(trace));
  for (const command of app.extensions.commands.list()) {
    if (registry.has(command.name)) {
      throw new Error(`Command already registered: ${command.name}`);
    }
    registry.register(command);
  }
  registry.register(createHelpCommand(registry, host.text));
  return registry;
}
