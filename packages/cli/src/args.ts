export interface CliArgs {
  mode: "chat";
  agentId: string;
}

export function parseCliArgs(args: string[]): CliArgs {
  const positionalArgs = args.filter((argument) => argument !== "--");
  const mode = positionalArgs[0] ?? "chat";
  if (mode !== "chat") throw new Error(`Unknown mode: ${mode}`);
  const agentId = positionalArgs[1] ?? "coding";
  if (!isAgentId(agentId)) throw new Error(`Invalid agent id: ${agentId}`);
  if (positionalArgs.length > 2) {
    throw new Error(`Unexpected argument: ${positionalArgs[2]}`);
  }
  return { mode, agentId };
}

import { isAgentId } from "@omni-agent/core";
