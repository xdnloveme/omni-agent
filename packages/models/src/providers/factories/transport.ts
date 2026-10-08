import { configuredToolConstraintCapability } from "../../runtime/tool-constraints";
import { createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import type { ModelCacheCapability } from "@omni-agent/core";
import { createProviderContribution } from "../../vendors/provider-contribution";
import type { VendorSettingsSchema } from "../../vendors/types";
import { createTransportStreams } from "../custom/stream-adapter";
import type { CompatibleModelDefinition, ModelTransport } from "../custom/types";
import { toProviderModel } from "../shared/model-mapper";
import type { ConnectionProviderFactory, VendorConnectionSpec } from "./types";

export interface TransportConnectionConfig {
  readonly providerId: string;
  readonly providerName: string;
  readonly baseUrl: string;
  readonly envVars: readonly string[];
  readonly credentialAliases?: readonly string[];
  readonly models: readonly CompatibleModelDefinition[];
  readonly transport: ModelTransport;
  readonly supportsStrictMode?: boolean;
  readonly cacheCapability?: ModelCacheCapability;
}

export interface TransportConnectionOptions extends TransportConnectionConfig {
  readonly id: string;
  readonly displayName: string;
  readonly settingsSchema?: VendorSettingsSchema;
}

export const transportProviderFactory: ConnectionProviderFactory<TransportConnectionConfig> = {
  create: (config) => {
    const modelContext = {
      providerId: config.providerId,
      baseUrl: config.baseUrl,
      api: "omni-custom",
    } as const;
    return [
      createProviderContribution(
        createProvider({
          id: config.providerId,
          name: config.providerName,
          baseUrl: config.baseUrl,
          auth: { apiKey: envApiKeyAuth(`${config.providerName} API key`, config.envVars) },
          models: config.models.map((model) => toProviderModel(model, modelContext)),
          api: createTransportStreams(config.transport),
        }),
        config.credentialAliases,
        config.cacheCapability,
        (model) =>
          configuredToolConstraintCapability(model, config.models, config.supportsStrictMode),
      ),
    ];
  },
};

export function transportConnection(
  options: TransportConnectionOptions,
): VendorConnectionSpec<TransportConnectionConfig> {
  const { id, displayName, settingsSchema, ...config } = options;
  return {
    definition: { id, displayName, providerId: config.providerId, settingsSchema },
    config,
    factory: transportProviderFactory,
  };
}
