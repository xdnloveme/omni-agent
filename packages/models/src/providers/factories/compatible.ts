import { createProvider, envApiKeyAuth, type ProviderStreams } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { mistralConversationsApi } from "@earendil-works/pi-ai/api/mistral-conversations.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { createProviderContribution } from "../../vendors/provider-contribution";
import type { VendorSettingsSchema } from "../../vendors/types";
import type {
  CompatibleModelDefinition,
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
  readonly credentialAliases?: readonly string[];
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
    return [
      createProviderContribution(
        createProvider({
          id: config.providerId,
          name: config.providerName,
          baseUrl: config.baseUrl,
          auth: { apiKey: envApiKeyAuth(`${config.providerName} API key`, config.envVars) },
          models: config.models.map((model) => toProviderModel(model, modelContext)),
          fetchModels: fetchModels
            ? async (context) =>
                (
                  await fetchModels({
                    credential: context.credential,
                    allowNetwork: context.allowNetwork,
                    force: context.force,
                    signal: context.signal,
                  })
                ).map((model) => toProviderModel(model, modelContext))
            : undefined,
          api: protocolImplementations[config.protocol](),
        }),
        config.credentialAliases,
      ),
    ];
  },
};

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
