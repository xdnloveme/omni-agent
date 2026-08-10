import {
  ProviderRepository,
  type ConfigurationScope,
  type ProviderDefinition,
} from "@omni-agent/models";
import type { ModelSelection } from "../models/model-service";
import { normalizeEndpoint } from "./endpoint";

export interface OmniConfigV1 {
  provider: string;
  endpoint: string;
  model: string;
  maxTokens?: number;
  contextWindow?: number;
  apiKeyEnvVar?: string;
}

export interface ConfigMigrationOptions {
  readonly cwd?: string;
  readonly globalDirectory?: string;
  readonly scope?: ConfigurationScope;
  readonly repository?: ProviderRepository;
}

const PROVIDER_MAP: Record<
  string,
  { vendorId: string; connectionId: string; endpoints: string[] }
> = {
  openai: { vendorId: "openai", connectionId: "default", endpoints: ["https://api.openai.com/v1"] },
  anthropic: {
    vendorId: "anthropic",
    connectionId: "default",
    endpoints: ["https://api.anthropic.com"],
  },
  google: {
    vendorId: "google",
    connectionId: "default",
    endpoints: ["https://generativelanguage.googleapis.com/v1beta"],
  },
  mistral: { vendorId: "mistral", connectionId: "default", endpoints: ["https://api.mistral.ai"] },
  deepseek: {
    vendorId: "deepseek",
    connectionId: "default",
    endpoints: ["https://api.deepseek.com"],
  },
  qwen: {
    vendorId: "qwen",
    connectionId: "default",
    endpoints: ["https://dashscope.aliyuncs.com/compatible-mode/v1"],
  },
  openrouter: {
    vendorId: "openrouter",
    connectionId: "default",
    endpoints: ["https://openrouter.ai/api/v1"],
  },
  kimi: { vendorId: "moonshot", connectionId: "global", endpoints: ["https://api.moonshot.ai/v1"] },
  "kimi-cn": {
    vendorId: "moonshot",
    connectionId: "cn",
    endpoints: ["https://api.moonshot.cn/v1"],
  },
  "kimi-code": {
    vendorId: "moonshot",
    connectionId: "kimi-coding",
    endpoints: ["https://api.kimi.com/coding/v1"],
  },
};

export async function migrateLegacyConfig(
  config: OmniConfigV1,
  options: ConfigMigrationOptions = {},
): Promise<ModelSelection> {
  if (config.provider === "custom") return migrateCustom(config, options);
  const mapped = PROVIDER_MAP[config.provider];
  const endpoint = normalizeEndpoint(config.endpoint);
  if (
    mapped &&
    endpoint !== null &&
    mapped.endpoints.some((candidate) => normalizeEndpoint(candidate) === endpoint)
  ) {
    return { vendorId: mapped.vendorId, connectionId: mapped.connectionId, modelId: config.model };
  }
  if (mapped) {
    throw new Error(
      `Cannot safely migrate a non-standard endpoint for provider: ${config.provider}`,
    );
  }
  throw new Error(`Cannot migrate unknown provider: ${config.provider}`);
}

async function migrateCustom(
  config: OmniConfigV1,
  options: ConfigMigrationOptions,
): Promise<ModelSelection> {
  const repository =
    options.repository ??
    new ProviderRepository({
      cwd: options.cwd,
      globalDirectory: options.globalDirectory,
    });
  const definition: ProviderDefinition = {
    id: "custom",
    displayName: "Custom OpenAI-compatible",
    connections: [
      {
        id: "default",
        displayName: "Default",
        providerId: "custom",
        baseUrl: config.endpoint,
        envVars: [config.apiKeyEnvVar ?? "OMNI_CUSTOM_API_KEY"],
        protocol: "openai-completions",
        models: [
          {
            id: config.model,
            name: config.model,
            contextWindow: config.contextWindow ?? 128_000,
            maxTokens: config.maxTokens ?? 4_096,
          },
        ],
      },
    ],
  };
  await repository.upsert(definition, { scope: options.scope });
  return { vendorId: "custom", connectionId: "default", modelId: config.model };
}
