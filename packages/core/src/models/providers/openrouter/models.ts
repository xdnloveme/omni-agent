import type { ModelPreset } from "../../types";

const endpoint = "https://openrouter.ai/api/v1";

export const openrouterPresets: ModelPreset[] = [
  {
    id: "openrouter-claude-opus-4.7",
    name: "OpenRouter Claude Opus 4.7",
    provider: "openrouter",
    description: "OpenRouter route for Anthropic Claude Opus 4.7",
    api: "openai-completions",
    endpoint,
    model: "anthropic/claude-opus-4.7",
    maxTokens: 128000,
    contextWindow: 1000000,
  },
  {
    id: "openrouter-gemini-3.1-pro-preview",
    name: "OpenRouter Gemini 3.1 Pro",
    provider: "openrouter",
    description: "OpenRouter route for Google Gemini 3.1 Pro Preview",
    api: "openai-completions",
    endpoint,
    model: "google/gemini-3.1-pro-preview",
    maxTokens: 65536,
    contextWindow: 1000000,
  },
  {
    id: "openrouter-deepseek-v3.2",
    name: "OpenRouter DeepSeek V3.2",
    provider: "openrouter",
    description: "OpenRouter route for DeepSeek V3.2",
    api: "openai-completions",
    endpoint,
    model: "deepseek/deepseek-v3.2",
    maxTokens: 163840,
    contextWindow: 163840,
  },
  {
    id: "openrouter-qwen3.6-plus",
    name: "OpenRouter Qwen3.6 Plus",
    provider: "openrouter",
    description: "OpenRouter route for Qwen3.6 Plus",
    api: "openai-completions",
    endpoint,
    model: "qwen/qwen3.6-plus",
    maxTokens: 65536,
    contextWindow: 1000000,
  },
];
