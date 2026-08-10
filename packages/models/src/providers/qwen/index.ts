import { defineVendor } from "../../vendors/define-vendor";
import { compatibleConnection } from "../factories/compatible";
import type { CompatibleModelDefinition } from "../custom/types";

const models: readonly CompatibleModelDefinition[] = [
  { id: "qwen3.6-plus", name: "Qwen 3.6 Plus", contextWindow: 1_000_000, maxTokens: 65_536 },
  { id: "qwen3-max", name: "Qwen 3 Max", contextWindow: 1_000_000, maxTokens: 65_536 },
  {
    id: "qwen3-coder-plus",
    name: "Qwen 3 Coder Plus",
    contextWindow: 1_000_000,
    maxTokens: 65_536,
  },
];

export function qwenVendorPlugin() {
  return defineVendor({
    id: "qwen",
    displayName: "Alibaba Cloud Qwen",
    pluginId: "builtin.qwen",
    connections: [
      compatibleConnection({
        id: "default",
        displayName: "DashScope",
        providerId: "qwen",
        providerName: "Alibaba Cloud Qwen",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        envVars: ["DASHSCOPE_API_KEY", "QWEN_API_KEY"],
        protocol: "openai-completions",
        models,
      }),
    ],
  });
}
