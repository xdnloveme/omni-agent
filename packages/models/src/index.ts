export { ModelRuntime } from "./runtime/model-runtime";
export type {
  AvailableModel,
  CredentialStatus,
  ModelRuntimeOptions,
} from "./runtime/model-runtime";

export { KeytarCredentialStore } from "./credentials/keytar-store";
export type {
  CredentialInfo,
  CredentialDiagnostic,
  CredentialAliasRegistry,
  CredentialIndexReconciler,
  CredentialOperationOptions,
  CredentialReconcileReport,
  CredentialStore,
  ModelAuthEvent,
  ModelAuthInteraction,
  ModelAuthMethod,
  ModelAuthPrompt,
  ModelAuthType,
  StoredCredential,
} from "./credentials/types";

export { VendorRegistry } from "./vendors/registry";
export { VendorPluginManager } from "./vendors/plugin-manager";
export type { ProviderReplacementTransaction } from "./vendors/plugin-manager";
export type {
  ModelSelection,
  ResolvedProviderSelection,
  VendorConnectionDefinition,
  VendorDefinition,
  VendorDiagnostic,
  VendorPlugin,
  VendorPluginContext,
  VendorPluginManifest,
  VendorSelectionContext,
  VendorSettingsSchema,
} from "./vendors/types";

export { builtinVendorPlugins } from "./providers";
export type {
  ModelTransport,
  ModelTransportModel,
  ModelTransportOptions,
  ModelTransportRequest,
} from "./providers/custom/types";
export { defineVendor } from "./vendors/define-vendor";
export { compatibleConnection } from "./providers/factories/compatible";
export type {
  CompatibleConnectionConfig,
  CompatibleConnectionOptions,
} from "./providers/factories/compatible";
export { transportConnection } from "./providers/factories/transport";
export type {
  TransportConnectionConfig,
  TransportConnectionOptions,
} from "./providers/factories/transport";
export { createVolcengineVendorPlugin } from "./providers/volcengine";
export { createZhipuVendorPlugin } from "./providers/zhipu";
export type {
  CompatibleModelDefinition,
  CompatibleProtocol,
  ModelCatalogRefreshContext,
} from "./providers/custom/types";

export { loadLocalVendorPlugins, toLocalVendorPlugin } from "./local/provider-loader";
export { LocalProviderRepository } from "./local/provider-repository";
export type { LocalProviderDefinition, LocalProviderSnapshot } from "./local/provider-repository";
export { containsSecretField } from "./schema/vendor-settings";
