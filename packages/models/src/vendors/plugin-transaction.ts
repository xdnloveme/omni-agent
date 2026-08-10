import type { ProviderContribution } from "./provider-contribution-type";
import type { PreparedVendorRegistration } from "./registry";
import type { VendorDefinition, VendorPlugin } from "./types";

export interface ActiveVendorPlugin {
  readonly plugin: VendorPlugin;
  readonly providers: readonly ProviderContribution[];
  readonly vendorId: string;
  readonly vendor: VendorDefinition;
  readonly registration: PreparedVendorRegistration;
}

export interface PreparedProviderChange {
  readonly kind: "activate";
  readonly plugin: VendorPlugin;
  readonly providers: readonly ProviderContribution[];
  readonly previous?: ActiveVendorPlugin;
  readonly replacing: boolean;
  readonly revision: number;
  readonly registration: PreparedVendorRegistration;
}

export interface PreparedProviderRemoval {
  readonly kind: "remove";
  readonly entry: ActiveVendorPlugin;
  readonly revision: number;
}

export type PreparedProviderTransaction = PreparedProviderChange | PreparedProviderRemoval;

export interface ProviderTransactionHost {
  commitPrepared(change: PreparedProviderTransaction): Promise<void>;
  abandonPrepared(change: PreparedProviderTransaction): Promise<void>;
}

type TransactionState = "prepared" | "committing" | "committed" | "rolled-back";

export interface ProviderReplacementTransaction {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export class ProviderPluginTransaction implements ProviderReplacementTransaction {
  private state: TransactionState = "prepared";

  constructor(
    private readonly host: ProviderTransactionHost,
    private readonly change: PreparedProviderTransaction,
  ) {}

  async commit(): Promise<void> {
    if (this.state === "committed") return;
    if (this.state === "rolled-back") {
      throw new Error(`Provider transaction already rolled back: ${transactionId(this.change)}`);
    }
    if (this.state === "committing") {
      throw new Error(`Provider transaction is already committing: ${transactionId(this.change)}`);
    }
    this.state = "committing";
    try {
      await this.host.commitPrepared(this.change);
      this.state = "committed";
    } catch (error) {
      this.state = "rolled-back";
      throw error;
    }
  }

  async rollback(): Promise<void> {
    if (this.state === "rolled-back") return;
    if (this.state === "committed") {
      throw new Error(`Provider transaction already committed: ${transactionId(this.change)}`);
    }
    if (this.state === "committing") {
      throw new Error(`Provider transaction is committing: ${transactionId(this.change)}`);
    }
    this.state = "rolled-back";
    await this.host.abandonPrepared(this.change);
  }
}

function transactionId(change: PreparedProviderTransaction): string {
  return change.kind === "activate" ? change.plugin.manifest.id : change.entry.plugin.manifest.id;
}
