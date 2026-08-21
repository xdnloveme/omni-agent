import type { ResolvedAgentAssemblyInput, ResolvedAgentAssemblyPlan } from "./contracts";
import { AgentCompositionPlanner } from "./agent-composition-planner";
import { deepFreeze } from "./deep-freeze";

export class AgentAssemblyPlanner {
  plan(input: ResolvedAgentAssemblyInput): ResolvedAgentAssemblyPlan {
    const composition = new AgentCompositionPlanner().plan(
      input.agentPackage.manifest.composition,
      input.agentPackage.blueprint.descriptor,
    );
    return deepFreeze({
      manifest: structuredClone(input.agentPackage.manifest),
      packageName: input.agentPackage.packageName,
      packageVersion: input.agentPackage.packageVersion,
      workspace: { ...input.workspace },
      workspaceRoots: [...input.workspaceRoots],
      globalDirectory: input.globalDirectory,
      modelSelection: structuredClone(input.modelSelection),
      resolvedModel: structuredClone(input.resolvedModel),
      extensionSources: input.extensionSources.map((source) => ({ ...source })),
      composition,
    });
  }
}
