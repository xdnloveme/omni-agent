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
import { catalogToolConstraintCapability, resolveToolConstraints } from "./tool-constraints";
import { throwIfAborted } from "@omni-agent/core";
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
    const declared = this.providers
      .get(selection.providerId)
      ?.resolveCacheCapability?.({ id: model.id, compat: model.compat });
    return resolveModelCacheCapability({
      api: model.api,
      compat: model.compat,
      explicit: declared,
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
    // The prepared request is authoritative. Never silently change its budget here.
    if (
      !Number.isSafeInteger(options.maxOutputTokens) ||
      options.maxOutputTokens < 1 ||
      options.maxOutputTokens > catalogModel.maxTokens ||
      options.maxOutputTokens >= selection.contextWindow
    ) {
      throw new Error("Invalid prepared model output budget");
    }
    throwIfAborted(options.signal);
    // A request-facing deployment override cannot inherit unverified catalog capabilities.
    const capability =
      selection.requestModelId && selection.requestModelId !== catalogModel.id
        ? { state: "unknown" as const, source: "unknown" as const }
        : (this.providers
            .get(selection.providerId)
            ?.resolveToolConstraintCapability?.({ id: model.id, compat: model.compat }) ??
          catalogToolConstraintCapability(model.compat));
    const constraints = resolveToolConstraints(request.tools, model.api, capability);
    // Compile before yielding observations so callers cannot alter a verified schema mid-request.
    const context = constraints.failure
      ? undefined
      : toBackendContext(request, constraints.decisions);
    if (constraints.decisions.length)
      yield { type: "tool_constraint_report", report: structuredClone(constraints) };
    if (constraints.failure)
      throw Object.assign(new Error(constraints.failure.message), constraints.failure);
    throwIfAborted(options.signal);
    // Normalize protocol capability spelling only after the capability has been resolved.
    const wireModel =
      model.api === "anthropic-messages"
        ? {
            ...model,
            compat: { ...model.compat, supportsStrictTools: capability.state === "supported" },
          }
        : model;
    const stream = this.models.streamSimple(wireModel, context!, {
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      maxRetries: options.maxRetries,
      apiKey: options.credential?.key,
      headers: selection.requestHeaders,
      sessionId: options.providerCache.sessionId,
      cacheRetention: options.providerCache.cacheRetention,
      maxTokens: options.maxOutputTokens,
      onPayload: this.onPayload,
    });
    let streamedText = "";
    for await (const event of stream) {
      if (event.type === "text_delta") {
        streamedText += event.delta;
        yield { type: "text_delta", delta: event.delta };
      } else if (event.type === "thinking_start")
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
      else if (event.type === "done") {
        const message = fromBackendMessage(event.message);
        const completeText = message.content
          .filter((content) => content.type === "text")
          .map((content) => content.text)
          .join("");
        if (!completeText.startsWith(streamedText)) {
          throw new Error("Model text stream does not match the completed response");
        }
        const remainingText = completeText.slice(streamedText.length);
        if (remainingText) yield { type: "text_delta", delta: remainingText };
        yield { type: "done", message };
      } else if (event.type === "error")
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
