import type { RuntimeModelSelection } from "@omni-agent/core";
import {
  CacheAwareModelRuntime,
  DefaultModelCachePolicy,
  KeytarCredentialStore,
  ProviderRepository,
  ModelRuntime,
  VendorPluginManager,
  VendorRegistry,
  builtinVendorPlugins,
  loadVendorPlugins,
  type ModelSelection,
  type ModelExecutionBinding,
  type AvailableModel,
  type CredentialStatus,
  type CredentialAliasRegistry,
  type CredentialIndexReconciler,
  type CredentialStore,
  type VendorPlugin,
  type VendorDefinition,
  type ModelAuthInteraction,
  type ModelAuthMethod,
  type ModelAuthType,
} from "@omni-agent/models";

export interface ModelServiceOptions {
  cwd: string;
  plugins?: VendorPlugin[];
  loadConfiguredProviders?: boolean;
  globalDirectory: string;
  credentials?: CredentialStore;
  credentialAliases?: CredentialAliasRegistry;
  credentialIndex?: CredentialIndexReconciler;
}

export interface ModelServiceDiagnostic {
  code: "credential_reconcile_failed" | "corrupt_credential_index_quarantined";
  source: "credentials";
  message: string;
}

/** Runtime assembly needs execution and selection, not provider administration. */
export type ModelAdministration = Pick<
  ModelService,
  | "resolve"
  | "isConfigured"
  | "getAuthMethods"
  | "login"
  | "listModels"
  | "listVendors"
  | "getVendor"
  | "providerPlugins"
  | "providers"
>;

export interface AgentModelService {
  readonly administration?: ModelAdministration;
  readonly runtime: CacheAwareModelRuntime;
  readonly providerPlugins?: VendorPluginManager;
  readonly diagnostics: readonly ModelServiceDiagnostic[];
  resolve(selection: ModelSelection): Promise<RuntimeModelSelection>;
  isConfigured(providerId: string): Promise<CredentialStatus | undefined>;
  dispose(): Promise<void>;
}

export class ModelService implements AgentModelService {
  get administration(): ModelAdministration {
    return this;
  }
  constructor(
    private readonly transportRuntime: ModelRuntime,
    readonly runtime: CacheAwareModelRuntime,
    readonly providerPlugins: VendorPluginManager,
    readonly providers: ProviderRepository,
    readonly diagnostics: readonly ModelServiceDiagnostic[] = [],
  ) {}

  resolve(selection: ModelSelection): Promise<RuntimeModelSelection> {
    return this.providerPlugins.resolve(selection);
  }

  isConfigured(providerId: string): Promise<CredentialStatus | undefined> {
    return this.transportRuntime.isConfigured(providerId);
  }

  async bindExecution(selection: ModelSelection): Promise<ModelExecutionBinding> {
    const resolved = await this.resolve(selection);
    const credential = await this.isConfigured(resolved.providerId);
    if (!credential) throw new Error("Bound model provider is not configured");
    return {
      selection: resolved,
      configuration: structuredClone(selection),
      cacheCapability: this.transportRuntime.getCacheCapability(resolved),
      credentialType: credential.type,
      transport: this.transportRuntime,
    };
  }

  getAuthMethods(providerId: string): ModelAuthMethod[] {
    return this.transportRuntime.getAuthMethods(providerId);
  }

  login(providerId: string, type: ModelAuthType, interaction: ModelAuthInteraction): Promise<void> {
    return this.transportRuntime.login(providerId, type, interaction);
  }

  async listModels(providerId: string): Promise<AvailableModel[]> {
    let models = this.transportRuntime.listModels(providerId);
    if (models.length === 0) {
      await this.transportRuntime.refreshProvider(providerId);
      models = this.transportRuntime.listModels(providerId);
    }
    return models;
  }

  listVendors(): VendorDefinition[] {
    return this.providerPlugins.vendors.list();
  }

  getVendor(vendorId: string): VendorDefinition | undefined {
    return this.providerPlugins.vendors.get(vendorId);
  }

  async dispose(): Promise<void> {
    this.runtime.clear();
    await this.providerPlugins.dispose();
  }
}

export async function createModelService(options: ModelServiceOptions): Promise<ModelService> {
  const { cwd } = options;
  const credentials = options.credentials ?? new KeytarCredentialStore();
  const runtime = new ModelRuntime({
    cwd,
    globalDirectory: options.globalDirectory,
    credentials,
    credentialAliases: options.credentialAliases,
    credentialIndex: options.credentialIndex,
  });
  const vendors = new VendorRegistry();
  const plugins = runtime.createPluginManager(vendors, cwd);
  const providers = new ProviderRepository({
    cwd,
    globalDirectory: options.globalDirectory,
  });
  const diagnostics: ModelServiceDiagnostic[] = [];
  try {
    if (options.loadConfiguredProviders !== false) {
      for (const plugin of await loadVendorPlugins(providers)) await plugins.register(plugin);
    }
    for (const plugin of builtinVendorPlugins()) {
      if (!vendors.get(plugin.vendor.id)) await plugins.register(plugin);
    }
    for (const plugin of options.plugins ?? []) await plugins.register(plugin);
    try {
      const report = await runtime.reconcileCredentials(
        vendors
          .list()
          .flatMap((vendor) => vendor.connections.map((connection) => connection.providerId)),
      );
      diagnostics.push(
        ...report.diagnostics.map((diagnostic) => ({
          code: "corrupt_credential_index_quarantined" as const,
          source: "credentials" as const,
          message: diagnostic.message,
        })),
      );
    } catch (error) {
      diagnostics.push({
        code: "credential_reconcile_failed",
        source: "credentials",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    const cacheAwareRuntime = new CacheAwareModelRuntime(
      runtime,
      new DefaultModelCachePolicy(),
      (selection) => runtime.getCacheCapability(selection),
    );
    return new ModelService(runtime, cacheAwareRuntime, plugins, providers, diagnostics);
  } catch (error) {
    await plugins.dispose();
    throw error;
  }
}

export type {
  ModelAuthEvent,
  ModelAuthInteraction,
  ModelAuthMethod,
  ModelAuthPrompt,
  ModelAuthType,
  ModelSelection,
  VendorSettingsSchema,
} from "@omni-agent/models";
