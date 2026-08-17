import { compatibleConnection } from "../providers/factories/compatible";
import { defineVendor } from "../vendors/define-vendor";
import type { VendorPlugin } from "../vendors/types";
import { ProviderRepository, type ProviderDefinition } from "./provider-repository";

export async function loadVendorPlugins(
  repository = new ProviderRepository(),
): Promise<VendorPlugin[]> {
  return (await repository.list()).map(toVendorPlugin);
}

export function toVendorPlugin(definition: ProviderDefinition): VendorPlugin {
  return defineVendor({
    id: definition.id,
    displayName: definition.displayName,
    connections: definition.connections.map((connection) =>
      compatibleConnection({
        id: connection.id,
        displayName: connection.displayName,
        providerId: connection.providerId,
        providerName: definition.displayName,
        baseUrl: connection.baseUrl,
        envVars: connection.envVars,
        protocol: connection.protocol,
        compat: connection.compat,
        credentialAliases: connection.credentialAliases,
        models: connection.models,
      }),
    ),
  });
}
