import { select, input, password } from "@inquirer/prompts";
import chalk from "chalk";

import { saveConfig, type OmniConfig } from "@omni-agent/core";
import { saveApiKey } from "@omni-agent/core";

interface OnboardingResult {
  config: OmniConfig;
  apiKey: string;
}

const PROVIDERS = [
  {
    name: "Anthropic",
    value: "anthropic" as const,
    description: "Claude models (claude-sonnet-4-20250514)",
    endpoint: "https://api.anthropic.com",
    model: "claude-sonnet-4-20250514",
  },
  {
    name: "Kimi",
    value: "kimi" as const,
    description: "Moonshot AI (moonshot-v1-auto)",
    endpoint: "https://api.moonshot.cn/v1",
    model: "moonshot-v1-auto",
  },
  {
    name: "Custom (OpenAI-compatible)",
    value: "custom" as const,
    description: "Any OpenAI-compatible API endpoint",
    endpoint: "",
    model: "",
  },
];

export async function runOnboarding(): Promise<OnboardingResult> {
  console.log();
  console.log(chalk.bold("  Welcome to omni-agent"));
  console.log(chalk.dim("  Let's set up your LLM provider.\n"));

  // Step 1: Select provider
  const providerChoice = await select({
    message: "Select your LLM provider",
    choices: PROVIDERS.map((p) => ({
      name: p.name,
      value: p.value,
      description: p.description,
    })),
  });

  const provider = PROVIDERS.find((p) => p.value === providerChoice)!;
  let endpoint = provider.endpoint;
  let model = provider.model;

  // Step 2: If custom, ask for endpoint and model
  if (providerChoice === "custom") {
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

  // Step 3: API key (masked)
  const apiKey = await password({
    message: `Enter your ${provider.name} API key`,
    mask: "*",
    validate: (val) => (val.length > 0 ? true : "API key cannot be empty"),
  });

  // Persist
  const config: OmniConfig = {
    provider: providerChoice,
    endpoint,
    model: model.trim(),
  };

  saveConfig(config);
  await saveApiKey(providerChoice, apiKey);

  console.log();
  console.log(chalk.green("  ✓ Configuration saved."));
  console.log(chalk.dim(`    Provider: ${provider.name}`));
  console.log(chalk.dim(`    Endpoint: ${endpoint}`));
  console.log(chalk.dim(`    Model: ${config.model}`));
  console.log(chalk.dim("    API key stored in system credential manager."));
  console.log();

  return { config, apiKey };
}
