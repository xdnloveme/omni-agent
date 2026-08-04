import { select, input, password } from "@inquirer/prompts";
import chalk from "chalk";

import {
  MODEL_PRESETS,
  getModelPresetById,
  type ModelPreset,
  type OmniConfig,
  type ProviderId,
} from "@omni-agent/core";
import { ConfigService, CredentialService } from "@omni-agent/app";

const configService = new ConfigService();
const credentialService = new CredentialService();

interface OnboardingResult {
  config: OmniConfig;
  apiKey: string;
}

type ProviderGroupId = string;

const PROVIDER_GROUPS: Record<string, ProviderGroupId> = {
  openai: "openai",
  anthropic: "anthropic",
  google: "google",
  mistral: "mistral",
  deepseek: "deepseek",
  qwen: "qwen",
  openrouter: "openrouter",
  kimi: "kimi",
  "kimi-cn": "kimi",
  "kimi-code": "kimi",
  custom: "custom",
};

const PROVIDER_LABELS: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google Gemini",
  mistral: "Mistral AI",
  deepseek: "DeepSeek",
  qwen: "Qwen",
  openrouter: "OpenRouter",
  kimi: "Kimi",
  custom: "Custom",
};

function getProviderGroup(provider: ProviderId): ProviderGroupId {
  return PROVIDER_GROUPS[provider] ?? provider;
}

function getProviderLabel(providerGroup: ProviderGroupId): string {
  return PROVIDER_LABELS[providerGroup] ?? providerGroup;
}

function getProviderChoices(): Array<{ name: string; value: ProviderGroupId; description: string }> {
  const providers = new Map<ProviderGroupId, ModelPreset[]>();
  for (const preset of MODEL_PRESETS) {
    const providerGroup = getProviderGroup(preset.provider);
    const group = providers.get(providerGroup);
    if (group) {
      group.push(preset);
    } else {
      providers.set(providerGroup, [preset]);
    }
  }

  return Array.from(providers, ([provider, presets]) => ({
    name: getProviderLabel(provider),
    value: provider,
    description: `${presets.length} model${presets.length === 1 ? "" : "s"} available`,
  }));
}

function getModelChoices(providerGroup: ProviderGroupId): Array<{ name: string; value: string; description: string }> {
  return MODEL_PRESETS.filter((preset) => getProviderGroup(preset.provider) === providerGroup).map((preset) => ({
    name: preset.name,
    value: preset.id,
    description: preset.description,
  }));
}

export async function runOnboarding(): Promise<OnboardingResult> {
  console.log();
  console.log(chalk.bold("  Welcome to omni-agent"));
  console.log(chalk.dim("  Let's set up your LLM provider.\n"));

  // Step 1: Select provider
  const providerChoice = await select<ProviderGroupId>({
    message: "Select your LLM provider",
    choices: getProviderChoices(),
    loop: false,
  });

  // Step 2: Select model preset within provider
  const modelChoice = await select<string>({
    message: `Select your ${getProviderLabel(providerChoice)} model`,
    choices: getModelChoices(providerChoice),
    loop: false,
  });

  const provider = getModelPresetById(modelChoice) as ModelPreset;
  let endpoint = provider.endpoint;
  let model = provider.model;
  const envApiKey = provider.apiKeyEnvVar ? process.env[provider.apiKeyEnvVar] : undefined;

  // Step 3: If custom, ask for endpoint and model
  if (provider.provider === "custom") {
    endpoint = await input({
      message: "Enter the API base URL",
      validate: (val) => {
        try {
          const url = new URL(val);
          if (!["http:", "https:"].includes(url.protocol)) {
            return "URL must start with http:// or https://";
          }
          return true;
        } catch {
          return "Please enter a valid URL (e.g. https://api.example.com/v1)";
        }
      },
    });

    model = await input({
      message: "Enter the model name",
      validate: (val) => (val.trim().length > 0 ? true : "Model name cannot be empty"),
    });
  }

  // Step 4: API key (masked)
  const apiKey = envApiKey ?? await password({
    message: `Enter your ${provider.name} API key`,
    mask: "*",
    validate: (val) => (val.length > 0 ? true : "API key cannot be empty"),
  });

  // Persist
  const config: OmniConfig = {
    provider: provider.provider,
    endpoint,
    model: model.trim(),
    maxTokens: provider.maxTokens,
    contextWindow: provider.contextWindow,
    apiKeyEnvVar: provider.apiKeyEnvVar,
  };

  configService.save(config);
  if (!envApiKey) {
    await credentialService.save(provider.keychainAccount ?? provider.provider, apiKey);
  }

  console.log();
  console.log(chalk.green("  ✓ Configuration saved."));
  console.log(chalk.dim(`    Provider: ${provider.name}`));
  console.log(chalk.dim(`    Endpoint: ${endpoint}`));
  console.log(chalk.dim(`    Model: ${config.model}`));
  console.log(chalk.dim(envApiKey ? `    API key loaded from ${provider.apiKeyEnvVar}.` : "    API key stored in system credential manager."));
  console.log();

  return { config, apiKey };
}
