import {
  createProvider,
  envApiKeyAuth,
  type Api,
  type Model,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { mistralConversationsApi } from "@earendil-works/pi-ai/api/mistral-conversations.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { createProviderContribution } from "../../vendors/provider-contribution";
import type { ProviderCacheCapabilityDeclaration } from "../../vendors/provider-contribution-type";
import type { VendorSettingsSchema } from "../../vendors/types";
import type {
  CompatibleModelDefinition,
  CompatibleProviderCompat,
  CompatibleProtocol,
  ModelCatalogRefreshContext,
} from "../custom/types";
import { toProviderModel } from "../shared/model-mapper";
import type { ConnectionProviderFactory, VendorConnectionSpec } from "./types";

const protocolImplementations = {
  "openai-completions": openAICompletionsApi,
  "openai-responses": openAIResponsesApi,
  "anthropic-messages": anthropicMessagesApi,
  "google-generative-ai": googleGenerativeAIApi,
  "mistral-conversations": mistralConversationsApi,
} satisfies Record<CompatibleProtocol, () => ProviderStreams>;

export interface CompatibleConnectionConfig {
  readonly providerId: string;
  readonly providerName: string;
  readonly baseUrl: string;
  readonly envVars: readonly string[];
  readonly protocol: CompatibleProtocol;
  readonly compat?: CompatibleProviderCompat;
  readonly credentialAliases?: readonly string[];
  readonly cacheCapability?: ProviderCacheCapabilityDeclaration;
  readonly models: readonly CompatibleModelDefinition[];
  readonly fetchModels?: (
    context: ModelCatalogRefreshContext,
  ) => Promise<readonly CompatibleModelDefinition[]>;
}

export interface CompatibleConnectionOptions extends CompatibleConnectionConfig {
  readonly id: string;
  readonly displayName: string;
  readonly settingsSchema?: VendorSettingsSchema;
}

export const compatibleProviderFactory: ConnectionProviderFactory<CompatibleConnectionConfig> = {
  create: (config) => {
    const modelContext = {
      providerId: config.providerId,
      baseUrl: config.baseUrl,
      api: config.protocol,
    } as const;
    const fetchModels = config.fetchModels;
    const mapModel = (model: CompatibleModelDefinition) =>
      applyPortableProtocolPolicy(toProviderModel(model, modelContext), config.compat);
    return [
      createProviderContribution(
        createProvider({
          id: config.providerId,
          name: config.providerName,
          baseUrl: config.baseUrl,
          auth: { apiKey: envApiKeyAuth(`${config.providerName} API key`, config.envVars) },
          models: config.models.map(mapModel),
          fetchModels: fetchModels
            ? async (context) =>
                (
                  await fetchModels({
                    credential: context.credential,
                    allowNetwork: context.allowNetwork,
                    force: context.force,
                    signal: context.signal,
                  })
                ).map(mapModel)
            : undefined,
          api: protocolImplementations[config.protocol](),
        }),
        config.credentialAliases,
        config.cacheCapability,
      ),
    ];
  },
};

function applyPortableProtocolPolicy(
  model: Model<Api>,
  compat: CompatibleProviderCompat | undefined,
): Model<Api> {
  if (model.api !== "openai-completions" && model.api !== "openai-responses") {
    return compat ? ({ ...model, compat: { ...model.compat, ...compat } } as Model<Api>) : model;
  }
  return {
    ...model,
    compat: {
      ...model.compat,
      ...compat,
      supportsDeveloperRole: false,
    },
  } as Model<Api>;
}

export function compatibleConnection(
  options: CompatibleConnectionOptions,
): VendorConnectionSpec<CompatibleConnectionConfig> {
  const { id, displayName, settingsSchema, ...config } = options;
  return {
    definition: { id, displayName, providerId: config.providerId, settingsSchema },
    config,
    factory: compatibleProviderFactory,
  };
}
