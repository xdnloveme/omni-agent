import { createModels, type AuthInteraction, type MutableModels } from "@earendil-works/pi-ai";
import type { ModelCacheCapability, ModelRequest, RuntimeModelSelection } from "@omni-agent/core";
import { FileModelsStore } from "../catalog/file-models-store";
import { createNodeAuthContext } from "../credentials/environment";
import { KeytarCredentialStore } from "../credentials/keytar-store";
import type {
  CredentialStore,
  CredentialAliasRegistry,
  CredentialReconcileReport,
  CredentialIndexReconciler,
  ModelAuthInteraction,
  ModelAuthMethod,
  ModelAuthType,
} from "../credentials/types";
import { VendorPluginManager } from "../vendors/plugin-manager";
import { getProviderAuthMethods, installProvider } from "../vendors/provider-contribution";
import type { ProviderContribution } from "../vendors/provider-contribution-type";
import type { VendorRegistry } from "../vendors/registry";
import { fromBackendMessage, toBackendContext } from "./message-mapper";
import type { ModelTransportEvent, ModelTransportExecutionOptions } from "../cache/contracts";
import { resolveModelCacheCapability } from "../cache/capability";

export interface ModelRuntimeOptions {
  cwd?: string;
  catalogDirectory?: string;
  globalDirectory?: string;
  credentials?: CredentialStore;
  credentialAliases?: CredentialAliasRegistry;
  credentialIndex?: CredentialIndexReconciler;
  /** Test/debug observation hook delegated to pi-ai; production does not retain payloads. */
  onPayload?: (payload: unknown) => void;
}

export interface AvailableModel {
  id: string;
  name: string;
  contextWindow: number;
  modelMaxOutputTokens: number;
}

export interface CredentialStatus {
  source?: string;
  type: "api_key" | "oauth";
}

export class ModelRuntime {
  private readonly credentials: CredentialStore;
  private readonly credentialAliases?: CredentialAliasRegistry;
  private readonly credentialIndex?: CredentialIndexReconciler;
  private readonly models: MutableModels;
  private readonly onPayload?: (payload: unknown) => void;
  private readonly providers = new Map<string, ProviderContribution>();

  constructor(options: ModelRuntimeOptions = {}) {
    const cwd = options.cwd ?? process.cwd();
    this.credentials = options.credentials ?? new KeytarCredentialStore();
    this.credentialAliases = options.credentialAliases ?? asAliasRegistry(this.credentials);
    this.credentialIndex = options.credentialIndex ?? asIndexReconciler(this.credentials);
    this.onPayload = options.onPayload;
    this.models = createModels({
      credentials: this.credentials,
      authContext: createNodeAuthContext(cwd, options.globalDirectory),
      modelsStore: new FileModelsStore(options.catalogDirectory),
    });
  }

  createPluginManager(vendors: VendorRegistry, cwd = process.cwd()): VendorPluginManager {
    return new VendorPluginManager(
      {
        getProvider: (providerId) => this.providers.get(providerId),
        setProvider: (provider) => {
          installProvider(this.models, provider);
          this.providers.set(provider.id, provider);
          this.credentialAliases?.configureAliases(provider.id, provider.credentialAliases);
        },
        deleteProvider: (providerId) => {
          this.models.deleteProvider(providerId);
          this.providers.delete(providerId);
          this.credentialAliases?.clearAliases(providerId);
        },
        getModel: (providerId, modelId) => {
          const model = this.models.getModel(providerId, modelId);
          return (
            model && {
              id: model.id,
              contextWindow: model.contextWindow,
              maxOutputTokens: model.maxTokens,
            }
          );
        },
        refresh: async (options) => {
          await this.models.refresh(options);
        },
      },
      vendors,
      cwd,
    );
  }

  reconcileCredentials(providerIds: readonly string[]): Promise<CredentialReconcileReport> {
    return this.credentialIndex?.reconcile(providerIds) ?? Promise.resolve({ diagnostics: [] });
  }

  isConfigured(providerId: string): Promise<CredentialStatus | undefined> {
    return this.models.checkAuth(providerId);
  }

  getAuthMethods(providerId: string): ModelAuthMethod[] {
    const provider = this.providers.get(providerId);
    if (!provider) throw new Error(`Unknown provider: ${providerId}`);
    return getProviderAuthMethods(provider);
  }

  async login(
    providerId: string,
    type: ModelAuthType,
    interaction: ModelAuthInteraction,
  ): Promise<void> {
    const backendInteraction: AuthInteraction = {
      signal: interaction.signal,
      prompt: (prompt) => interaction.prompt(prompt),
      notify: (event) => interaction.notify(event),
    };
    await this.models.login(providerId, type, backendInteraction);
  }

  listModels(providerId: string): AvailableModel[] {
    return this.models.getModels(providerId).map((model) => ({
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      modelMaxOutputTokens: model.maxTokens,
    }));
  }

  async refreshProvider(
    providerId: string,
    options: { force?: boolean; signal?: AbortSignal } = {},
  ): Promise<void> {
    await this.models.refresh({ providers: [providerId], ...options });
  }

  getCacheCapability(selection: RuntimeModelSelection): ModelCacheCapability {
    const model = this.models.getModel(selection.providerId, selection.modelId);
    if (!model)
      throw new Error(`Model is not registered: ${selection.providerId}/${selection.modelId}`);
    return resolveModelCacheCapability({
      api: model.api,
      baseUrl: model.baseUrl,
      compat: model.compat,
      explicit: this.providers.get(selection.providerId)?.cacheCapability,
    });
  }

  async *stream(
    selection: RuntimeModelSelection,
    request: ModelRequest,
    options: ModelTransportExecutionOptions,
  ): AsyncIterable<ModelTransportEvent> {
    const catalogModel = this.models.getModel(selection.providerId, selection.modelId);
    if (!catalogModel)
      throw new Error(`Model is not registered: ${selection.providerId}/${selection.modelId}`);
    const model = selection.requestModelId
      ? { ...catalogModel, id: selection.requestModelId }
      : catalogModel;
    const stream = this.models.streamSimple(model, toBackendContext(request), {
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      maxRetries: options.maxRetries,
      apiKey: options.credential?.key,
      headers: selection.requestHeaders,
      sessionId: options.providerCache.sessionId,
      cacheRetention: options.providerCache.cacheRetention,
      maxTokens: Math.min(options.maxOutputTokens, catalogModel.maxTokens),
      onPayload: this.onPayload,
    });
    for await (const event of stream) {
      if (event.type === "text_delta") yield { type: "text_delta", delta: event.delta };
      else if (event.type === "thinking_start")
        yield { type: "thinking_start", contentIndex: event.contentIndex };
      else if (event.type === "thinking_delta")
        yield {
          type: "thinking_delta",
          contentIndex: event.contentIndex,
          delta: event.delta,
        };
      else if (event.type === "thinking_end")
        yield {
          type: "thinking_end",
          contentIndex: event.contentIndex,
          content: event.content,
        };
      else if (event.type === "done")
        yield { type: "done", message: fromBackendMessage(event.message) };
      else if (event.type === "error")
        yield { type: "error", error: fromBackendMessage(event.error) };
    }
  }
}

function asAliasRegistry(store: CredentialStore): CredentialAliasRegistry | undefined {
  const candidate = store as Partial<CredentialAliasRegistry>;
  return typeof candidate.configureAliases === "function" &&
    typeof candidate.clearAliases === "function"
    ? (candidate as CredentialAliasRegistry)
    : undefined;
}

function asIndexReconciler(store: CredentialStore): CredentialIndexReconciler | undefined {
  const candidate = store as Partial<CredentialIndexReconciler>;
  return typeof candidate.reconcile === "function"
    ? (candidate as CredentialIndexReconciler)
    : undefined;
}
