import type { Api } from "@mariozechner/pi-ai";

export type BuiltinProviderId =
  | "openai"
  | "anthropic"
  | "google"
  | "mistral"
  | "deepseek"
  | "qwen"
  | "openrouter"
  | "kimi"
  | "kimi-cn"
  | "kimi-code"
  | "custom";

export type ProviderId = BuiltinProviderId | (string & {});

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
  apiKeyEnvVar?: string;
  headers?: () => Record<string, string>;
}
