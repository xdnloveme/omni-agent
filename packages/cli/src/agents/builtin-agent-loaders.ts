interface AgentPackageModule {
  readonly agentBlueprint?: unknown;
}

type AgentPackageLoader = () => Promise<AgentPackageModule>;

const builtinAgentLoaders: Readonly<Record<string, AgentPackageLoader>> = {
  coding: () => import("@omni-agent/agent-coding"),
  "financial-analysis": () => import("@omni-agent/agent-financial-analysis"),
};

export function loadBuiltinAgentPackage(agentId: string): Promise<AgentPackageModule> | undefined {
  return builtinAgentLoaders[agentId]?.();
}
