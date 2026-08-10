import type { JsonValue, RuntimeModelSelection } from "@omni-agent/core";
import type { ProviderContribution } from "./provider-contribution-type";
import type { VendorSettingsSchema } from "../schema/vendor-settings";

export interface CatalogModel {
  id: string;
  contextWindow: number;
  maxOutputTokens: number;
}

export interface ProviderCatalog {
  getModel(providerId: string, modelId: string): CatalogModel | undefined;
}

export interface ProviderCollection extends ProviderCatalog {
  getProvider(providerId: string): ProviderContribution | undefined;
  setProvider(provider: ProviderContribution): void;
  deleteProvider(providerId: string): void;
  refresh(options: { providers: readonly string[] }): Promise<void>;
}

export interface VendorConnectionDefinition {
  readonly id: string;
  readonly displayName: string;
  readonly providerId: string;
  readonly settingsSchema?: VendorSettingsSchema;
}

export interface VendorDefinition {
  readonly id: string;
  readonly displayName: string;
  readonly connections: readonly VendorConnectionDefinition[];
}

export interface ModelSelection {
  vendorId: string;
  connectionId: string;
  modelId: string;
  settings?: Record<string, JsonValue>;
}

export interface VendorPluginManifest {
  readonly id: string;
  readonly version: string;
  readonly apiVersion: 1;
}

export interface VendorPluginContext {
  cwd: string;
}

export interface VendorSelectionContext {
  catalog: ProviderCatalog;
  vendor: VendorDefinition;
  connection: VendorConnectionDefinition;
}

export type ResolvedProviderSelection = RuntimeModelSelection;

export type { VendorSettingsSchema } from "../schema/vendor-settings";

export interface VendorPlugin {
  readonly manifest: VendorPluginManifest;
  readonly vendor: VendorDefinition;
  createProviders(
    context: VendorPluginContext,
  ): readonly ProviderContribution[] | Promise<readonly ProviderContribution[]>;
  resolveSelection?(
    selection: ModelSelection,
    context: VendorSelectionContext,
  ): ResolvedProviderSelection | Promise<ResolvedProviderSelection>;
  dispose?(): void | Promise<void>;
}

export interface VendorDiagnostic {
  pluginId: string;
  source: string;
  message: string;
}
