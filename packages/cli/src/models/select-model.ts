import { input, select } from "@inquirer/prompts";
import {
  LocalProviderRegistrationCoordinator,
  type ModelService,
  type ModelSelection,
} from "@omni-agent/app";
import type { JsonValue } from "@omni-agent/core";
import { formatSettingDefault, parseSettingValue } from "./model-settings";

export async function selectModel(
  modelService: ModelService,
  prepareProvider: (providerId: string) => Promise<void>,
): Promise<ModelSelection> {
  const vendors = modelService.listVendors();
  const choice = await select<
    | { readonly kind: "vendor"; readonly vendor: (typeof vendors)[number] }
    | { readonly kind: "custom" }
  >({
    message: "Select your model provider",
    choices: [
      ...vendors.map((vendor) => ({
        name: vendor.displayName,
        value: { kind: "vendor" as const, vendor },
      })),
      { name: "Custom OpenAI-compatible", value: { kind: "custom" as const } },
    ],
    loop: false,
  });
  if (choice.kind === "custom") return selectCustomModel(modelService, prepareProvider);
  const { vendor } = choice;
  const connection =
    vendor.connections.length === 1
      ? vendor.connections[0]
      : await select({
          message: `Select your ${vendor.displayName} connection`,
          choices: vendor.connections.map((connection) => ({
            name: connection.displayName,
            value: connection,
          })),
          loop: false,
        });
  await prepareProvider(connection.providerId);
  const models = await modelService.listModels(connection.providerId);
  if (models.length === 0) throw new Error(`No models available for ${vendor.displayName}`);
  const modelId = await select({
    message: `Select your ${vendor.displayName} model`,
    choices: models.map((model) => ({
      name: model.name,
      value: model.id,
      description: `${model.contextWindow.toLocaleString()} context`,
    })),
    loop: false,
  });
  const settings: Record<string, JsonValue> = {};
  const required = new Set(connection.settingsSchema?.required ?? []);
  for (const [key, property] of Object.entries(connection.settingsSchema?.properties ?? {})) {
    const value = await input({
      message: `Enter ${key}${required.has(key) ? "" : " (optional)"}`,
      default: formatSettingDefault(property),
      validate: (value) => {
        if (!value.trim()) return required.has(key) ? `${key} is required` : true;
        try {
          parseSettingValue(property, value);
          return true;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
    });
    if (value.trim()) settings[key] = parseSettingValue(property, value);
  }
  return {
    vendorId: vendor.id,
    connectionId: connection.id,
    modelId,
    ...(Object.keys(settings).length > 0 ? { settings } : {}),
  };
}

async function selectCustomModel(
  modelService: ModelService,
  prepareProvider: (providerId: string) => Promise<void>,
): Promise<ModelSelection> {
  const id = await input({
    message: "Enter a vendor id",
    default: "custom",
    validate: (value) =>
      /^[a-z0-9][a-z0-9-]*$/.test(value) || "Use lowercase letters, numbers, and hyphens",
  });
  const baseUrl = await input({
    message: "Enter the OpenAI-compatible base URL",
    validate: (value) => {
      try {
        const url = new URL(value);
        return ["http:", "https:"].includes(url.protocol) || "URL must use http or https";
      } catch {
        return "Enter a valid URL";
      }
    },
  });
  const modelId = await input({
    message: "Enter the model id",
    validate: (value) => Boolean(value.trim()) || "Model id is required",
  });
  const contextWindow = Number(
    await input({
      message: "Enter the context window",
      default: "128000",
      validate: (value) =>
        (Number.isFinite(Number(value)) && Number(value) > 0) || "Enter a positive number",
    }),
  );
  const maxTokens = Number(
    await input({
      message: "Enter maximum output tokens",
      default: "4096",
      validate: (value) =>
        (Number.isFinite(Number(value)) && Number(value) > 0) || "Enter a positive number",
    }),
  );
  const envVar = await input({
    message: "Enter the API key environment variable",
    default: `${id.replace(/-/g, "_").toUpperCase()}_API_KEY`,
    validate: (value) =>
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) || "Enter a valid environment variable name",
  });
  await new LocalProviderRegistrationCoordinator(modelService).register({
    id,
    displayName: id,
    baseUrl,
    envVars: [envVar],
    protocol: "openai-completions",
    models: [{ id: modelId, contextWindow, maxTokens }],
  });
  await prepareProvider(id);
  return { vendorId: id, connectionId: "default", modelId };
}
