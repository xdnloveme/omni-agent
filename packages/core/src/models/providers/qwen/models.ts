import type { ModelPreset } from "../../types";

const endpoint = "https://dashscope.aliyuncs.com/compatible-mode/v1";

export const qwenPresets: ModelPreset[] = [
  {
    id: "qwen3.6-plus",
    name: "Qwen3.6 Plus",
    provider: "qwen",
    description: "Alibaba Cloud DashScope OpenAI-compatible flagship model",
    api: "openai-completions",
    endpoint,
    model: "qwen3.6-plus",
    maxTokens: 65536,
    contextWindow: 1000000,
  },
  {
    id: "qwen3-max",
    name: "Qwen3 Max",
    provider: "qwen",
    description: "Alibaba Cloud DashScope large model",
    api: "openai-completions",
    endpoint,
    model: "qwen3-max",
    maxTokens: 65536,
    contextWindow: 1000000,
  },
  {
    id: "qwen3-coder-plus",
    name: "Qwen3 Coder Plus",
    provider: "qwen",
    description: "Alibaba Cloud DashScope coding model",
    api: "openai-completions",
    endpoint,
    model: "qwen3-coder-plus",
    maxTokens: 65536,
    contextWindow: 1000000,
  },
];
