import type { ModelPreset } from "../../types";

export const customPresets: ModelPreset[] = [
  {
    id: "custom-openai-compatible",
    name: "Custom (OpenAI-compatible)",
    provider: "custom",
    description: "Any OpenAI-compatible API endpoint",
    api: "openai-completions",
    endpoint: "",
    model: "",
    maxTokens: 4096,
    contextWindow: 128000,
  },
];
