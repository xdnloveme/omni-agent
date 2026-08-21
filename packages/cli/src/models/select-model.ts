import {
  ProviderRegistrationCoordinator,
  type ModelService,
  type ModelSelection,
} from "@omni-agent/app";
import type { JsonValue } from "@omni-agent/core";
import { formatSettingDefault, parseSettingValue } from "./model-settings";
import type { OnboardingInteractionPort } from "../host-services";

export async function selectModel(
  modelService: ModelService,
  prepareProvider: (providerId: string) => Promise<void>,
  interaction: OnboardingInteractionPort,
): Promise<ModelSelection> {
  const vendors = modelService.listVendors();
  const vendorId = await interaction.selectProvider([
    ...vendors.map((vendor) => ({ id: vendor.id, label: vendor.displayName })),
    { id: "__custom__", label: "Custom OpenAI-compatible" },
  ]);
  if (vendorId === "__custom__")
    return selectCustomModel(modelService, prepareProvider, interaction);
  const vendor = vendors.find((candidate) => candidate.id === vendorId);
  if (!vendor) throw new Error(`Unknown model vendor: ${vendorId}`);
  const connectionId =
    vendor.connections.length === 1
      ? vendor.connections[0]!.id
      : await interaction.select(
          `Select your ${vendor.displayName} connection`,
          vendor.connections.map((item) => ({ id: item.id, label: item.displayName })),
          { loop: false },
        );
  const connection = vendor.connections.find((candidate) => candidate.id === connectionId);
  if (!connection) throw new Error(`Unknown connection for ${vendor.displayName}`);
  await prepareProvider(connection.providerId);
  const models = await modelService.listModels(connection.providerId);
  if (models.length === 0) throw new Error(`No models available for ${vendor.displayName}`);
  const modelId = await interaction.selectModel(
    models.map((model) => ({
      id: model.id,
      label: model.name,
      description: `${model.contextWindow.toLocaleString()} context`,
    })),
    `Select your ${vendor.displayName} model`,
  );
  const settings: Record<string, JsonValue> = {};
  const required = new Set(connection.settingsSchema?.required ?? []);
  for (const [key, property] of Object.entries(connection.settingsSchema?.properties ?? {})) {
    const value = await interaction.input({
      message: `Enter ${key}${required.has(key) ? "" : " (optional)"}`,
      defaultValue: formatSettingDefault(property),
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
  interaction: OnboardingInteractionPort,
): Promise<ModelSelection> {
  const id = await interaction.input({
    message: "Enter a vendor id",
    defaultValue: "custom",
    validate: (value) =>
      /^[a-z0-9][a-z0-9-]*$/.test(value) || "Use lowercase letters, numbers, and hyphens",
  });
  const baseUrl = await interaction.input({
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
  const modelId = await interaction.input({
    message: "Enter the model id",
    validate: (value) => Boolean(value.trim()) || "Model id is required",
  });
  const contextWindow = Number(
    await interaction.input({
      message: "Enter the context window",
      defaultValue: "128000",
      validate: (value) =>
        (Number.isFinite(Number(value)) && Number(value) > 0) || "Enter a positive number",
    }),
  );
  const maxTokens = Number(
    await interaction.input({
      message: "Enter maximum output tokens",
      defaultValue: "4096",
      validate: (value) =>
        (Number.isFinite(Number(value)) && Number(value) > 0) || "Enter a positive number",
    }),
  );
  const envVar = await interaction.input({
    message: "Enter the API key environment variable",
    defaultValue: `${id.replace(/-/g, "_").toUpperCase()}_API_KEY`,
    validate: (value) =>
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) || "Enter a valid environment variable name",
  });
  await new ProviderRegistrationCoordinator(modelService).register(
    {
      id,
      displayName: id,
      connections: [
        {
          id: "default",
          displayName: "Default",
          providerId: id,
          baseUrl,
          envVars: [envVar],
          protocol: "openai-completions",
          models: [{ id: modelId, contextWindow, maxTokens }],
        },
      ],
    },
    { scope: "global" },
  );
  await prepareProvider(id);
  return { vendorId: id, connectionId: "default", modelId };
}
