import type { RuntimeModelSelection } from "@omni-agent/core";
import {
  KeytarCredentialStore,
  LocalProviderRepository,
  ModelRuntime,
  VendorPluginManager,
  VendorRegistry,
  builtinVendorPlugins,
  loadLocalVendorPlugins,
  type ModelSelection,
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
  cwd?: string;
  plugins?: VendorPlugin[];
  loadLocalProviders?: boolean;
  credentials?: CredentialStore;
  credentialAliases?: CredentialAliasRegistry;
  credentialIndex?: CredentialIndexReconciler;
}

export interface ModelServiceDiagnostic {
  code: "credential_reconcile_failed" | "corrupt_credential_index_quarantined";
  source: "credentials";
  message: string;
}

export class ModelService {
  constructor(
    readonly runtime: ModelRuntime,
    readonly providerPlugins: VendorPluginManager,
    readonly localProviders: LocalProviderRepository,
    readonly diagnostics: readonly ModelServiceDiagnostic[] = [],
  ) {}

  resolve(selection: ModelSelection): Promise<RuntimeModelSelection> {
    return this.providerPlugins.resolve(selection);
  }

  isConfigured(providerId: string): Promise<CredentialStatus | undefined> {
    return this.runtime.isConfigured(providerId);
  }

  getAuthMethods(providerId: string): ModelAuthMethod[] {
    return this.runtime.getAuthMethods(providerId);
  }

  login(providerId: string, type: ModelAuthType, interaction: ModelAuthInteraction): Promise<void> {
    return this.runtime.login(providerId, type, interaction);
  }

  async listModels(providerId: string): Promise<AvailableModel[]> {
    let models = this.runtime.listModels(providerId);
    if (models.length === 0) {
      await this.runtime.refreshProvider(providerId);
      models = this.runtime.listModels(providerId);
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
    await this.providerPlugins.dispose();
  }
}

export async function createModelService(options: ModelServiceOptions = {}): Promise<ModelService> {
  const cwd = options.cwd ?? process.cwd();
  const credentials = options.credentials ?? new KeytarCredentialStore();
  const runtime = new ModelRuntime({
    cwd,
    credentials,
    credentialAliases: options.credentialAliases,
    credentialIndex: options.credentialIndex,
  });
  const vendors = new VendorRegistry();
  const plugins = runtime.createPluginManager(vendors, cwd);
  const localProviders = new LocalProviderRepository(cwd);
  const diagnostics: ModelServiceDiagnostic[] = [];
  try {
    for (const plugin of builtinVendorPlugins()) await plugins.register(plugin);
    if (options.loadLocalProviders !== false) {
      const source = ".omni-agent.local/providers.json";
      try {
        for (const plugin of await loadLocalVendorPlugins(localProviders)) {
          await plugins.registerOptional(plugin, source);
        }
      } catch (error) {
        plugins.diagnostics.push({
          pluginId: "local.providers",
          source,
          message: error instanceof Error ? error.message : String(error),
        });
      }
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
    return new ModelService(runtime, plugins, localProviders, diagnostics);
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
