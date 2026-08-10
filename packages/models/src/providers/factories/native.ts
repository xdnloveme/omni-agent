import type { Provider } from "@earendil-works/pi-ai";
import { createProviderContribution } from "../../vendors/provider-contribution";
import type { VendorConnectionDefinition } from "../../vendors/types";
import type { ConnectionProviderFactory, VendorConnectionSpec } from "./types";

interface NativeProviderConfig {
  readonly create: () => Provider;
  readonly credentialAliases?: readonly string[];
}

const nativeProviderFactory: ConnectionProviderFactory<NativeProviderConfig> = {
  create: (config) => [createProviderContribution(config.create(), config.credentialAliases)],
};

export function nativeConnection(
  definition: VendorConnectionDefinition,
  create: () => Provider,
  credentialAliases?: readonly string[],
): VendorConnectionSpec<NativeProviderConfig> {
  return {
    definition,
    config: { create, credentialAliases },
    factory: nativeProviderFactory,
  };
}
