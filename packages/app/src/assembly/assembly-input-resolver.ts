import { join, resolve } from "node:path";
import type { AgentAssemblyRequest, ResolvedAgentAssemblyInput } from "./contracts";
import { AgentModelNotConfiguredError, toAgentAssemblyError } from "./errors";

export class AssemblyInputResolver {
  async resolve(request: AgentAssemblyRequest): Promise<ResolvedAgentAssemblyInput> {
    const agentId = request.agentPackage.manifest.metadata.id;
    try {
      const modelSelection = await request.configService.resolveModel(agentId);
      if (!modelSelection) throw new AgentModelNotConfiguredError(agentId);
      const resolvedModel = await request.modelService.resolve(modelSelection);
      if (!(await request.modelService.isConfigured(resolvedModel.providerId))) {
        throw new Error(`Provider is not configured: ${resolvedModel.providerId}`);
      }
      return {
        ...request,
        modelSelection,
        resolvedModel,
        extensionSources: request.extensionSourceLoader
          ? [
              {
                sourceOriginId: "global-local-extensions",
                diagnosticSource: join(request.globalDirectory, "extensions.mjs"),
                requirement: "optional",
              },
              {
                sourceOriginId: "workspace-local-extensions",
                diagnosticSource: resolve(request.workspace.root, "omni.extensions.mjs"),
                requirement: "optional",
              },
            ]
          : [],
      };
    } catch (error) {
      throw toAgentAssemblyError(error, agentId, "input_resolution", "configuration-and-model");
    }
  }
}
