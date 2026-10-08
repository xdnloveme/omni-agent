import type { ConfigService } from "../config/config-service";
import type { AgentModelService } from "./model-service";
import { AgentModelNotConfiguredError } from "../assembly/errors";

export async function resolveAgentModel(
  agentId: string,
  config: ConfigService,
  models: AgentModelService,
) {
  const modelSelection = await config.resolveModel(agentId);
  if (!modelSelection) throw new AgentModelNotConfiguredError(agentId);
  const resolvedModel = await models.resolve(modelSelection);
  if (!(await models.isConfigured(resolvedModel.providerId)))
    throw new Error(`Provider is not configured: ${resolvedModel.providerId}`);
  return { modelSelection, resolvedModel };
}
