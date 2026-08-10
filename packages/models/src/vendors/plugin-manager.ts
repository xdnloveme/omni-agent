import type { RuntimeModelSelection } from "@omni-agent/core";
import { validateProviderContribution } from "./provider-contribution";
import type { ProviderContribution } from "./provider-contribution-type";
import {
  ProviderPluginTransaction,
  type ActiveVendorPlugin,
  type PreparedProviderChange,
  type PreparedProviderRemoval,
  type PreparedProviderTransaction,
  type ProviderReplacementTransaction,
  type ProviderTransactionHost,
} from "./plugin-transaction";
import { VendorRegistry } from "./registry";
import { VendorSelectionResolver } from "./selection-resolver";
import type { ModelSelection, ProviderCollection, VendorDiagnostic, VendorPlugin } from "./types";

export type { ProviderReplacementTransaction } from "./plugin-transaction";

export class VendorPluginManager implements ProviderTransactionHost {
  readonly diagnostics: VendorDiagnostic[] = [];
  private readonly active = new Map<string, ActiveVendorPlugin>();
  private readonly activeByVendor = new Map<string, ActiveVendorPlugin>();
  private readonly revisions = new Map<string, number>();
  private readonly resolver: VendorSelectionResolver;

  constructor(
    private readonly models: ProviderCollection,
    readonly vendors: VendorRegistry,
    private readonly cwd: string,
  ) {
    this.resolver = new VendorSelectionResolver(models, vendors, (vendorId) =>
      this.activeByVendor.get(vendorId),
    );
  }

  async register(plugin: VendorPlugin): Promise<void> {
    await (await this.prepare(plugin, false)).commit();
  }

  async replace(plugin: VendorPlugin): Promise<void> {
    await (await this.prepareReplace(plugin)).commit();
  }

  prepareReplace(plugin: VendorPlugin): Promise<ProviderReplacementTransaction> {
    return this.prepare(plugin, true);
  }

  async unregister(pluginId: string): Promise<void> {
    const entry = this.active.get(pluginId);
    if (!entry) return;
    await new ProviderPluginTransaction(this, {
      kind: "remove",
      entry,
      revision: this.revisionOf(pluginId),
    }).commit();
  }

  getPlugin(pluginId: string): VendorPlugin | undefined {
    return this.active.get(pluginId)?.plugin;
  }

  async registerOptional(plugin: VendorPlugin, source: string): Promise<void> {
    try {
      await this.register(plugin);
    } catch (error) {
      this.diagnostics.push({
        pluginId: plugin.manifest.id,
        source,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  resolve(selection: ModelSelection): Promise<RuntimeModelSelection> {
    return this.resolver.resolve(selection);
  }

  async dispose(): Promise<void> {
    for (const pluginId of [...this.active.keys()].reverse()) await this.unregister(pluginId);
  }

  hasProvider(providerId: string): boolean {
    return Boolean(this.models.getProvider(providerId));
  }

  async commitPrepared(change: PreparedProviderTransaction): Promise<void> {
    if (change.kind === "remove") {
      await this.commitRemoval(change);
      return;
    }
    const { plugin, providers, previous, replacing, revision, registration } = change;
    let mutationStarted = false;
    try {
      this.validatePreparedState(plugin, providers, previous, revision, registration.definition);
      mutationStarted = true;
      this.applyContribution(plugin, providers, previous, registration);
      this.bumpRevision(plugin.manifest.id);
    } catch (error) {
      let rollbackError: unknown;
      if (mutationStarted) {
        try {
          this.restoreContribution(plugin, providers, previous);
        } catch (restoreError) {
          rollbackError = restoreError;
          this.diagnostics.push({
            pluginId: plugin.manifest.id,
            source: replacing ? "replacement-rollback-failed" : "activation-rollback-failed",
            message: restoreError instanceof Error ? restoreError.message : String(restoreError),
          });
        }
      }
      await this.disposePlugin(
        plugin,
        replacing ? "replacement-commit-rollback" : "activation-commit-rollback",
      );
      if (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `Provider transaction and rollback failed: ${plugin.manifest.id}`,
        );
      }
      throw error;
    }
    if (previous) await this.disposePlugin(previous.plugin, "replaced-plugin-cleanup");
  }

  async abandonPrepared(change: PreparedProviderTransaction): Promise<void> {
    if (change.kind === "remove") return;
    await this.disposePlugin(
      change.plugin,
      change.replacing ? "replacement-rollback" : "activation-rollback",
    );
  }

  private async prepare(
    plugin: VendorPlugin,
    replacing: boolean,
  ): Promise<ProviderPluginTransaction> {
    const previous = this.active.get(plugin.manifest.id);
    this.validateManifest(plugin, replacing && Boolean(previous));
    const registration = this.vendors.prepare(plugin.vendor);
    this.validateVendorAvailability(registration.definition, previous);
    let providers: ProviderContribution[];
    try {
      providers = [...(await plugin.createProviders({ cwd: this.cwd }))];
      this.validateContributions(
        plugin,
        providers,
        new Set(previous?.providers.map(({ id }) => id)),
      );
    } catch (error) {
      await this.disposePlugin(plugin, replacing ? "replacement-prepare" : "activation-prepare");
      throw error;
    }
    return new ProviderPluginTransaction(this, {
      kind: "activate",
      plugin,
      providers,
      previous,
      replacing,
      revision: this.revisionOf(plugin.manifest.id),
      registration,
    });
  }

  private async commitRemoval(change: PreparedProviderRemoval): Promise<void> {
    const { entry, revision } = change;
    const pluginId = entry.plugin.manifest.id;
    if (this.revisionOf(pluginId) !== revision || this.active.get(pluginId) !== entry) {
      throw new Error(`Provider transaction is stale: ${pluginId}`);
    }

    const removedProviders: ProviderContribution[] = [];
    let vendorRemoved = false;
    try {
      for (const provider of [...entry.providers].reverse()) {
        this.models.deleteProvider(provider.id);
        removedProviders.push(provider);
      }
      this.vendors.unregister(entry.vendorId);
      vendorRemoved = true;
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      if (vendorRemoved) {
        attempt(rollbackErrors, () => this.vendors.registerPrepared(entry.registration));
      }
      for (const provider of [...removedProviders].reverse()) {
        attempt(rollbackErrors, () => this.models.setProvider(provider));
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          `Provider removal and rollback failed: ${pluginId}`,
        );
      }
      throw error;
    }

    this.active.delete(pluginId);
    this.activeByVendor.delete(entry.vendorId);
    this.bumpRevision(pluginId);
    await this.disposePlugin(entry.plugin, "unregister");
  }

  private applyContribution(
    plugin: VendorPlugin,
    providers: readonly ProviderContribution[],
    previous: ActiveVendorPlugin | undefined,
    registration: PreparedProviderChange["registration"],
  ): void {
    if (previous) {
      for (const provider of [...previous.providers].reverse())
        this.models.deleteProvider(provider.id);
      this.vendors.unregister(previous.vendorId);
      this.active.delete(previous.plugin.manifest.id);
      this.activeByVendor.delete(previous.vendorId);
    }
    for (const provider of providers) this.models.setProvider(provider);
    this.vendors.registerPrepared(registration);
    const vendor = this.vendors.get(registration.definition.id);
    if (!vendor) throw new Error(`Vendor registration failed: ${registration.definition.id}`);
    const entry: ActiveVendorPlugin = {
      plugin,
      providers,
      vendorId: vendor.id,
      vendor,
      registration,
    };
    this.active.set(plugin.manifest.id, entry);
    this.activeByVendor.set(vendor.id, entry);
  }

  private restoreContribution(
    plugin: VendorPlugin,
    providers: readonly ProviderContribution[],
    previous: ActiveVendorPlugin | undefined,
  ): void {
    const errors: unknown[] = [];
    for (const provider of [...providers].reverse()) {
      attempt(errors, () => this.models.deleteProvider(provider.id));
    }
    attempt(errors, () => this.vendors.unregister(plugin.vendor.id));
    this.active.delete(plugin.manifest.id);
    this.activeByVendor.delete(plugin.vendor.id);
    if (previous) {
      const beforeRestore = errors.length;
      for (const provider of previous.providers)
        attempt(errors, () => this.models.setProvider(provider));
      if (errors.length === beforeRestore) {
        attempt(errors, () => this.vendors.registerPrepared(previous.registration));
      }
      if (errors.length === beforeRestore) {
        this.active.set(previous.plugin.manifest.id, previous);
        this.activeByVendor.set(previous.vendorId, previous);
      } else {
        for (const provider of [...previous.providers].reverse()) {
          attempt(errors, () => this.models.deleteProvider(provider.id));
        }
        attempt(errors, () => this.vendors.unregister(previous.vendorId));
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        `Failed to restore provider transaction: ${plugin.manifest.id}`,
      );
    }
  }

  private validateManifest(plugin: VendorPlugin, allowExisting: boolean): void {
    const { id, version, apiVersion } = plugin.manifest;
    if (!id.trim() || !version.trim()) throw new Error("Vendor plugin id and version are required");
    if (apiVersion !== 1) throw new Error(`Unsupported vendor plugin API: ${apiVersion}`);
    if (!allowExisting && this.active.has(id))
      throw new Error(`Vendor plugin already registered: ${id}`);
  }

  private validateVendorAvailability(
    vendor: VendorPlugin["vendor"],
    previous: ActiveVendorPlugin | undefined,
  ): void {
    const owner = this.vendors.get(vendor.id);
    if (owner && owner.id !== previous?.vendorId) {
      throw new Error(`Vendor already registered: ${vendor.id}`);
    }
  }

  private validatePreparedState(
    plugin: VendorPlugin,
    providers: readonly ProviderContribution[],
    previous: ActiveVendorPlugin | undefined,
    revision: number,
    vendor: VendorPlugin["vendor"],
  ): void {
    if (
      this.revisionOf(plugin.manifest.id) !== revision ||
      this.active.get(plugin.manifest.id) !== previous
    ) {
      throw new Error(`Provider transaction is stale: ${plugin.manifest.id}`);
    }
    const replaceable = new Set(previous?.providers.map(({ id }) => id));
    this.validateContributions(plugin, providers, replaceable);
    this.validateVendorAvailability(vendor, previous);
  }

  private validateContributions(
    plugin: VendorPlugin,
    providers: readonly ProviderContribution[],
    replaceable: ReadonlySet<string>,
  ): void {
    const ids = new Set<string>();
    for (const provider of providers) {
      validateProviderContribution(provider);
      if (ids.has(provider.id)) throw new Error(`Duplicate runtime provider: ${provider.id}`);
      if (this.models.getProvider(provider.id) && !replaceable.has(provider.id)) {
        throw new Error(`Runtime provider already registered: ${provider.id}`);
      }
      ids.add(provider.id);
    }
    for (const connection of plugin.vendor.connections) {
      if (!ids.has(connection.providerId)) {
        throw new Error(`Connection references unowned runtime provider: ${connection.providerId}`);
      }
    }
  }

  private revisionOf(pluginId: string): number {
    return this.revisions.get(pluginId) ?? 0;
  }

  private bumpRevision(pluginId: string): void {
    this.revisions.set(pluginId, this.revisionOf(pluginId) + 1);
  }

  private async disposePlugin(plugin: VendorPlugin, source: string): Promise<void> {
    try {
      await plugin.dispose?.();
    } catch (error) {
      this.diagnostics.push({
        pluginId: plugin.manifest.id,
        source,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function attempt(errors: unknown[], operation: () => void): void {
  try {
    operation();
  } catch (error) {
    errors.push(error);
  }
}
