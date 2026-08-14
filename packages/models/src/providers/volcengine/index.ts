import { defineVendor } from "../../vendors/define-vendor";
import type { CompatibleModelDefinition } from "../custom/types";
import { compatibleConnection } from "../factories/compatible";
import { resolveOutputBudget } from "../../vendors/output-budget";

const DEPLOYMENT_SETTING = "deploymentId";

export function createVolcengineVendorPlugin(models: readonly CompatibleModelDefinition[]) {
  return defineVendor({
    id: "volcengine",
    displayName: "Volcengine Ark",
    connections: [
      compatibleConnection({
        id: "cn-beijing",
        displayName: "China North 2 (Beijing)",
        providerId: "volcengine",
        providerName: "Volcengine Ark",
        baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
        envVars: ["ARK_API_KEY"],
        protocol: "openai-completions",
        models,
        settingsSchema: {
          type: "object",
          required: [DEPLOYMENT_SETTING],
          properties: {
            [DEPLOYMENT_SETTING]: { type: "string", pattern: "^ep-[A-Za-z0-9_-]+$" },
          },
          additionalProperties: false,
        },
      }),
    ],
    resolveSelection: (selection, context) => {
      const model = context.catalog.getModel(context.connection.providerId, selection.modelId);
      if (!model) throw new Error(`Unknown model: ${selection.modelId}`);
      const requestModelId = selection.settings?.[DEPLOYMENT_SETTING];
      if (typeof requestModelId !== "string") {
        throw new Error(`Missing setting: ${DEPLOYMENT_SETTING}`);
      }
      return {
        vendorId: "volcengine",
        connectionId: context.connection.id,
        providerId: context.connection.providerId,
        modelId: model.id,
        requestModelId,
        settings: selection.settings,
        contextWindow: model.contextWindow,
        ...resolveOutputBudget({
          contextWindow: model.contextWindow,
          modelMaxOutputTokens: model.maxOutputTokens,
          requestedOutputTokens: selection.requestedOutputTokens,
        }),
      };
    },
  });
}
