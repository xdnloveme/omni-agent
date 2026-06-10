import type { ModelPreset } from "../../types";

export const anthropicPresets: ModelPreset[] = [
  {
    id: "anthropic-claude-sonnet-4",
    name: "Anthropic",
    provider: "anthropic",
    description: "Claude models (claude-sonnet-4-20250514)",
    api: "anthropic-messages",
    endpoint: "https://api.anthropic.com",
    model: "claude-sonnet-4-20250514",
    maxTokens: 16384,
    contextWindow: 200000,
  },
];
