import type { AgentExtension, AgentFactory } from "@omni-agent/app";
import type { SkillRuntime } from "@omni-agent/core";

export interface AgentComposition {
  readonly agentId: string;
  readonly extension: AgentExtension;
  readonly skills?: {
    readonly runtime: SkillRuntime;
    readonly buildSystemPrompt: () => Promise<string>;
  };
}

interface AgentPackageModule {
  agentFactory?: AgentFactory<unknown>;
}

export async function createAgentComposition(agentId: string): Promise<AgentComposition> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(agentId)) {
    throw new Error(`Invalid agent id: ${agentId}`);
  }
  const packageName = `@omni-agent/agent-${agentId}`;
  let agentPackage: AgentPackageModule;
  try {
    agentPackage = (await import(packageName)) as AgentPackageModule;
  } catch (error) {
    throw new Error(`Unable to load agent package "${packageName}"`, { cause: error });
  }

  if (!agentPackage.agentFactory || typeof agentPackage.agentFactory.create !== "function") {
    throw new Error(`Agent package "${packageName}" does not export a valid agentFactory`);
  }

  const composition = await agentPackage.agentFactory.create({ cwd: process.cwd() });
  if (!isAgentComposition(composition) || composition.agentId !== agentId) {
    throw new Error(`Agent package "${packageName}" returned an invalid composition`);
  }
  return composition;
}

function isAgentComposition(value: unknown): value is AgentComposition {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AgentComposition>;
  const contributesSelectedAgent = candidate.extension?.contributions.agents?.some(
    (contribution) => contribution.definition.id === candidate.agentId,
  );
  return Boolean(
    typeof candidate.agentId === "string" &&
    candidate.extension &&
    typeof candidate.extension === "object" &&
    candidate.extension.manifest &&
    typeof candidate.extension.manifest.id === "string" &&
    contributesSelectedAgent,
  );
}
