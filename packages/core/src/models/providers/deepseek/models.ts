import type { ModelPreset } from "../../types";

export const deepseekPresets: ModelPreset[] = [
  {
    id: "deepseek-chat",
    name: "DeepSeek Chat",
    provider: "deepseek",
    description: "DeepSeek OpenAI-compatible chat model",
    api: "openai-completions",
    endpoint: "https://api.deepseek.com",
    model: "deepseek-chat",
    maxTokens: 8192,
    contextWindow: 64000,
  },
  {
    id: "deepseek-reasoner",
    name: "DeepSeek Reasoner",
    provider: "deepseek",
    description: "DeepSeek OpenAI-compatible reasoning model",
    api: "openai-completions",
    endpoint: "https://api.deepseek.com",
    model: "deepseek-reasoner",
    maxTokens: 8192,
    contextWindow: 64000,
  },
];
