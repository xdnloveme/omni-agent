import type { Api } from "@mariozechner/pi-ai";

export type ProviderId = "anthropic" | "kimi" | "kimi-cn" | "kimi-code" | "custom";

export interface ModelPreset {
  id: string;
  name: string;
  description: string;
  provider: ProviderId;
  api: Api;
  endpoint: string;
  model: string;
  maxTokens: number;
  contextWindow: number;
  keychainAccount?: string;
  headers?: () => Record<string, string>;
}
