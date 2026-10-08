import { join, resolve } from "node:path";
import type { AgentAssemblyRequest, ResolvedAgentAssemblyInput } from "./contracts";
import { toAgentAssemblyError } from "./errors";
import { resolveAgentModel } from "../models/resolve-agent-model";

export class AssemblyInputResolver {
  async resolve(request: AgentAssemblyRequest): Promise<ResolvedAgentAssemblyInput> {
    const agentId = request.agentPackage.manifest.metadata.id;
    try {
      const { modelSelection, resolvedModel } = await resolveAgentModel(
        agentId,
        request.configService,
        request.modelService,
      );
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
