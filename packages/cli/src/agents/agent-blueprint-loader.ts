import type { AgentBlueprint } from "@omni-agent/app";

interface AgentPackageModule {
  readonly agentBlueprint?: unknown;
}

export async function loadAgentBlueprint(agentId: string): Promise<AgentBlueprint> {
  assertAgentId(agentId);
  const packageName = `@omni-agent/agent-${agentId}`;
  let agentPackage: AgentPackageModule;
  try {
    agentPackage = (await import(packageName)) as AgentPackageModule;
  } catch (error) {
    throw new Error(`Unable to load agent package "${packageName}"`, { cause: error });
  }

  if (!isAgentBlueprint(agentPackage.agentBlueprint)) {
    throw new Error(`Agent package "${packageName}" does not export a valid agentBlueprint`);
  }
  if (agentPackage.agentBlueprint.id !== agentId) {
    throw new Error(
      `Agent blueprint id mismatch: expected ${agentId}, received ${agentPackage.agentBlueprint.id}`,
    );
  }
  return agentPackage.agentBlueprint;
}

function isAgentBlueprint(value: unknown): value is AgentBlueprint {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AgentBlueprint>;
  return typeof candidate.id === "string" && typeof candidate.build === "function";
}

function assertAgentId(agentId: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(agentId)) {
    throw new Error(`Invalid agent id: ${agentId}`);
  }
}
