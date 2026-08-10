import {
  ProviderRepository,
  toVendorPlugin,
  type ConfigurationScope,
  type ProviderDefinition,
  type VendorPluginManager,
} from "@omni-agent/models";

interface ProviderRegistrationHost {
  readonly providerPlugins: Pick<VendorPluginManager, "prepareReplace">;
  readonly providers: ProviderRepository;
}

const registrationQueues = new WeakMap<ProviderRepository, Promise<void>>();

export class ProviderRegistrationCoordinator {
  constructor(private readonly host: ProviderRegistrationHost) {}

  async register(
    definition: ProviderDefinition,
    options: { scope?: ConfigurationScope } = {},
  ): Promise<void> {
    return enqueueRegistration(this.host.providers, () =>
      this.registerExclusive(definition, options),
    );
  }

  private async registerExclusive(
    definition: ProviderDefinition,
    options: { scope?: ConfigurationScope },
  ): Promise<void> {
    const effective = await this.host.providers.previewUpsert(definition, options);
    const transaction = await this.host.providerPlugins.prepareReplace(toVendorPlugin(effective));
    const snapshot = await this.host.providers.snapshot(options.scope);
    try {
      await this.host.providers.upsert(definition, options);
    } catch (error) {
      try {
        await transaction.rollback();
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `Provider repository write and runtime rollback failed: ${definition.id}`,
        );
      }
      throw error;
    }
    try {
      await transaction.commit();
    } catch (error) {
      try {
        await this.host.providers.restore(snapshot);
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          `Provider registration and repository restore failed: ${definition.id}`,
        );
      }
      throw error;
    }
  }
}

function enqueueRegistration<T>(
  repository: ProviderRepository,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = registrationQueues.get(repository) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(operation);
  registrationQueues.set(
    repository,
    result.then(
      () => undefined,
      () => undefined,
    ),
  );
  return result;
}
