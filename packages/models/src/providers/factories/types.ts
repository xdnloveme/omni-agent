import type { ProviderContribution } from "../../vendors/provider-contribution-type";
import type { VendorConnectionDefinition, VendorPluginContext } from "../../vendors/types";

export interface ProviderFactoryContext extends VendorPluginContext {
  readonly vendorId: string;
  readonly connection: VendorConnectionDefinition;
}

export interface ConnectionProviderFactory<TConfig> {
  create(
    config: TConfig,
    context: ProviderFactoryContext,
  ): readonly ProviderContribution[] | Promise<readonly ProviderContribution[]>;
}

export interface VendorConnectionSpec<TConfig = unknown> {
  readonly definition: VendorConnectionDefinition;
  readonly config: TConfig;
  readonly factory: ConnectionProviderFactory<TConfig>;
}
