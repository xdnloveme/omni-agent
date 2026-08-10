import type { VendorConnectionSpec } from "../providers/factories/types";
import type { ProviderContribution } from "./provider-contribution-type";
import type { VendorPlugin } from "./types";

export interface DefineVendorOptions {
  readonly id: string;
  readonly displayName: string;
  readonly pluginId?: string;
  readonly version?: string;
  readonly connections: readonly VendorConnectionSpec[];
  readonly resolveSelection?: NonNullable<VendorPlugin["resolveSelection"]>;
}

export function defineVendor(options: DefineVendorOptions): VendorPlugin {
  if (options.connections.length === 0) throw new Error(`Vendor has no connections: ${options.id}`);
  const connectionIds = new Set<string>();
  const providerIds = new Set<string>();
  for (const { definition } of options.connections) {
    if (connectionIds.has(definition.id)) {
      throw new Error(`Duplicate connection: ${options.id}/${definition.id}`);
    }
    if (providerIds.has(definition.providerId)) {
      throw new Error(`Duplicate runtime provider: ${definition.providerId}`);
    }
    connectionIds.add(definition.id);
    providerIds.add(definition.providerId);
  }
  return {
    manifest: {
      id: options.pluginId ?? `vendor.${options.id}`,
      version: options.version ?? "1.0.0",
      apiVersion: 1,
    },
    vendor: {
      id: options.id,
      displayName: options.displayName,
      connections: options.connections.map(({ definition }) => definition),
    },
    createProviders: async (pluginContext) => {
      const providers: ProviderContribution[] = [];
      for (const connection of options.connections) {
        providers.push(
          ...(await connection.factory.create(connection.config, {
            ...pluginContext,
            vendorId: options.id,
            connection: connection.definition,
          })),
        );
      }
      return providers;
    },
    ...(options.resolveSelection ? { resolveSelection: options.resolveSelection } : {}),
  };
}
