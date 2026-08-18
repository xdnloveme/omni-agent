import type { Provider } from "@earendil-works/pi-ai";
import { createProviderContribution } from "../../vendors/provider-contribution";
import type { ProviderCacheCapabilityDeclaration } from "../../vendors/provider-contribution-type";
import type { VendorConnectionDefinition } from "../../vendors/types";
import type { ConnectionProviderFactory, VendorConnectionSpec } from "./types";

interface NativeProviderConfig {
  readonly create: () => Provider;
  readonly credentialAliases?: readonly string[];
  readonly cacheCapability?: ProviderCacheCapabilityDeclaration;
}

const nativeProviderFactory: ConnectionProviderFactory<NativeProviderConfig> = {
  create: (config) => [
    createProviderContribution(config.create(), config.credentialAliases, config.cacheCapability),
  ],
};

interface NativeConnectionOptions {
  readonly credentialAliases?: readonly string[];
  readonly cacheCapability?: ProviderCacheCapabilityDeclaration;
}

export function nativeConnection(
  definition: VendorConnectionDefinition,
  create: () => Provider,
  options: NativeConnectionOptions = {},
): VendorConnectionSpec<NativeProviderConfig> {
  return {
    definition,
    config: { create, ...options },
    factory: nativeProviderFactory,
  };
}
