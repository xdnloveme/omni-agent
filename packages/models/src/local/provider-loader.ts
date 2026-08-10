import { compatibleConnection } from "../providers/factories/compatible";
import { defineVendor } from "../vendors/define-vendor";
import type { VendorPlugin } from "../vendors/types";
import { LocalProviderRepository, type LocalProviderDefinition } from "./provider-repository";

export async function loadLocalVendorPlugins(
  repository = new LocalProviderRepository(),
): Promise<VendorPlugin[]> {
  return (await repository.list()).map(toLocalVendorPlugin);
}

export function toLocalVendorPlugin(definition: LocalProviderDefinition): VendorPlugin {
  const connectionId = definition.connectionId ?? "default";
  return defineVendor({
    id: definition.id,
    displayName: definition.displayName,
    connections: [
      compatibleConnection({
        id: connectionId,
        displayName: definition.connectionName ?? definition.displayName,
        providerId: definition.id,
        providerName: definition.displayName,
        baseUrl: definition.baseUrl,
        envVars: definition.envVars,
        protocol: definition.protocol,
        credentialAliases: definition.credentialAliases,
        models: definition.models,
      }),
    ],
  });
}
