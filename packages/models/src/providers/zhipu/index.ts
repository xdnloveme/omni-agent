import { defineVendor } from "../../vendors/define-vendor";
import { automaticShortCache } from "../../cache/profiles";
import type { CompatibleModelDefinition } from "../custom/types";
import { compatibleConnection } from "../factories/compatible";

export function createZhipuVendorPlugin(models: readonly CompatibleModelDefinition[]) {
  return defineVendor({
    id: "zhipu",
    displayName: "Zhipu AI",
    connections: [
      compatibleConnection({
        id: "default",
        displayName: "Zhipu AI",
        providerId: "zhipu",
        providerName: "Zhipu AI",
        baseUrl: "https://open.bigmodel.cn/api/paas/v4",
        envVars: ["ZHIPU_API_KEY", "ZAI_API_KEY"],
        protocol: "openai-completions",
        cacheCapability: automaticShortCache,
        models,
      }),
    ],
  });
}
