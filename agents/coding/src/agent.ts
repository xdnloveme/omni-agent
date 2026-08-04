import { defineAgent } from "@omni-agent/core";

export function createCodingAgent(instructions: () => Promise<string>) {
  return defineAgent<{ cwd: string }>({
    id: "coding",
    description: "Local coding agent with filesystem, shell, search, web, and skills capabilities.",
    instructions,
    maxTurns: 10,
  });
}
