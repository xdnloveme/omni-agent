import {
  LocalProviderRepository,
  toLocalVendorPlugin,
  type LocalProviderDefinition,
  type VendorPluginManager,
} from "@omni-agent/models";

interface LocalProviderRegistrationHost {
  readonly providerPlugins: Pick<VendorPluginManager, "prepareReplace">;
  readonly localProviders: LocalProviderRepository;
}

export class LocalProviderRegistrationCoordinator {
  constructor(private readonly host: LocalProviderRegistrationHost) {}

  async register(definition: LocalProviderDefinition): Promise<void> {
    const transaction = await this.host.providerPlugins.prepareReplace(
      toLocalVendorPlugin(definition),
    );
    const snapshot = await this.host.localProviders.snapshot();
    try {
      await this.host.localProviders.upsert(definition);
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
    try {
      await transaction.commit();
    } catch (error) {
      try {
        await this.host.localProviders.restore(snapshot);
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          `Local provider registration and repository restore failed: ${definition.id}`,
        );
      }
      throw error;
    }
  }
}
