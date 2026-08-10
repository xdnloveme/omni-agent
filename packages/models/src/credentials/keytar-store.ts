import keytar from "keytar";
import { rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { AtomicJsonFile } from "../storage/atomic-json-file";
import type {
  CredentialAliasRegistry,
  CredentialIndexReconciler,
  CredentialInfo,
  CredentialOperationOptions,
  CredentialReconcileReport,
  CredentialStore,
  StoredCredential,
} from "./types";

const SERVICE_NAME = "omni-agent";
const ACCOUNT_PREFIX = "credential:";
const LEGACY_ACCOUNTS: Readonly<Record<string, readonly string[]>> = {
  moonshotai: ["kimi"],
  "moonshotai-cn": ["kimi-cn"],
  "kimi-coding": ["kimi-code"],
};

export class CredentialIndexCorruptError extends Error {
  constructor(cause?: unknown) {
    super("Credential index is corrupt", { cause });
    this.name = "CredentialIndexCorruptError";
  }
}

export class KeytarCredentialStore
  implements CredentialStore, CredentialAliasRegistry, CredentialIndexReconciler
{
  private readonly providerChains = new Map<string, Promise<unknown>>();
  private readonly aliases = new Map<string, readonly string[]>();
  private readonly aliasOwners = new Map<string, string>();
  private readonly indexFile: AtomicJsonFile<CredentialInfo[]>;
  private indexChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly indexPath = join(homedir(), ".omni-agent", "credential-index.json"),
  ) {
    this.indexFile = new AtomicJsonFile(indexPath);
  }

  async read(
    providerId: string,
    options?: CredentialOperationOptions,
  ): Promise<StoredCredential | undefined> {
    throwIfAborted(options);
    const canonical = parseCredential(await keytar.getPassword(SERVICE_NAME, account(providerId)));
    if (canonical) return canonical;
    for (const legacyAccount of this.legacyAccounts(providerId)) {
      const legacy = parseCredential(await keytar.getPassword(SERVICE_NAME, legacyAccount));
      if (legacy) return legacy;
    }
    return undefined;
  }

  async list(options?: CredentialOperationOptions): Promise<readonly CredentialInfo[]> {
    throwIfAborted(options);
    await this.indexChain;
    return this.readIndex();
  }

  modify(
    providerId: string,
    fn: (current: StoredCredential | undefined) => Promise<StoredCredential | undefined>,
    options?: CredentialOperationOptions,
  ): Promise<StoredCredential | undefined> {
    return this.enqueueProvider(providerId, async () => {
      throwIfAborted(options);
      const current = await this.read(providerId, options);
      const next = await fn(current);
      throwIfAborted(options);
      if (next === undefined) return current;
      const providerAccount = account(providerId);
      const previousCanonical = await keytar.getPassword(SERVICE_NAME, providerAccount);
      await keytar.setPassword(SERVICE_NAME, providerAccount, JSON.stringify(next));
      try {
        await this.updateIndex((entries) => [
          ...entries.filter((item) => item.providerId !== providerId),
          { providerId, type: next.type },
        ]);
      } catch (error) {
        await this.compensateCredential(providerAccount, previousCanonical, error);
      }
      return next;
    });
  }

  delete(providerId: string, options?: CredentialOperationOptions): Promise<void> {
    return this.enqueueProvider(providerId, async () => {
      throwIfAborted(options);
      const providerAccount = account(providerId);
      const previous = await keytar.getPassword(SERVICE_NAME, providerAccount);
      await keytar.deletePassword(SERVICE_NAME, providerAccount);
      try {
        await this.updateIndex((entries) =>
          entries.filter((item) => item.providerId !== providerId),
        );
      } catch (error) {
        if (previous !== null) {
          try {
            await keytar.setPassword(SERVICE_NAME, providerAccount, previous);
          } catch (restoreError) {
            throw new AggregateError(
              [error, restoreError],
              `Credential delete and compensation failed: ${providerId}`,
            );
          }
        }
        throw error;
      }
    });
  }

  configureAliases(providerId: string, aliases: readonly string[]): void {
    const previous = this.aliases.get(providerId) ?? [];
    const next = [...new Set([providerId, ...(LEGACY_ACCOUNTS[providerId] ?? []), ...aliases])];
    for (const alias of next) {
      const owner = this.aliasOwners.get(alias);
      if (owner && owner !== providerId) {
        throw new Error(`Credential alias is already owned by another provider: ${alias}`);
      }
    }
    for (const alias of previous) {
      if (this.aliasOwners.get(alias) === providerId) this.aliasOwners.delete(alias);
    }
    this.aliases.set(providerId, next);
    for (const alias of next) this.aliasOwners.set(alias, providerId);
  }

  clearAliases(providerId: string): void {
    for (const alias of this.aliases.get(providerId) ?? []) {
      if (this.aliasOwners.get(alias) === providerId) this.aliasOwners.delete(alias);
    }
    this.aliases.delete(providerId);
  }

  async reconcile(providerIds: readonly string[]): Promise<CredentialReconcileReport> {
    const quarantined = await this.enqueueIndex(() => this.readIndexForReconcile());
    const reconciled = new Map<string, CredentialInfo | undefined>();
    for (const providerId of new Set(providerIds)) {
      await this.enqueueProvider(providerId, async () => {
        const providerAccount = account(providerId);
        let raw = await keytar.getPassword(SERVICE_NAME, providerAccount);
        if (!raw) {
          for (const legacyAccount of this.legacyAccounts(providerId)) {
            const legacy = await keytar.getPassword(SERVICE_NAME, legacyAccount);
            const credential = parseCredential(legacy);
            if (!credential) continue;
            raw = JSON.stringify(credential);
            await keytar.setPassword(SERVICE_NAME, providerAccount, raw);
            await keytar.deletePassword(SERVICE_NAME, legacyAccount);
            break;
          }
        }
        const credential = parseCredential(raw);
        reconciled.set(providerId, credential ? { providerId, type: credential.type } : undefined);
      });
    }
    await this.updateIndex((current) => {
      const entries = new Map(current.map((entry) => [entry.providerId, entry]));
      for (const [providerId, credential] of reconciled) {
        if (credential) entries.set(providerId, credential);
        else entries.delete(providerId);
      }
      return [...entries.values()];
    });
    return {
      diagnostics: quarantined
        ? [
            {
              code: "corrupt_index_quarantined",
              message: "Credential index was corrupt and has been quarantined",
            },
          ]
        : [],
    };
  }

  private legacyAccounts(providerId: string): readonly string[] {
    return this.aliases.get(providerId) ?? [providerId, ...(LEGACY_ACCOUNTS[providerId] ?? [])];
  }

  private async compensateCredential(
    providerAccount: string,
    previous: string | null,
    originalError: unknown,
  ): Promise<never> {
    try {
      if (previous === null) await keytar.deletePassword(SERVICE_NAME, providerAccount);
      else await keytar.setPassword(SERVICE_NAME, providerAccount, previous);
    } catch (compensationError) {
      throw new AggregateError(
        [originalError, compensationError],
        `Credential update and compensation failed: ${providerAccount}`,
      );
    }
    throw originalError;
  }

  private updateIndex(update: (entries: CredentialInfo[]) => CredentialInfo[]): Promise<void> {
    return this.enqueueIndex(async () => this.indexFile.write(update(await this.readIndex())));
  }

  private async readIndex(): Promise<CredentialInfo[]> {
    let parsed: CredentialInfo[] | undefined;
    try {
      parsed = await this.indexFile.read();
    } catch (error) {
      throw new CredentialIndexCorruptError(error);
    }
    if (parsed === undefined) return [];
    if (
      !Array.isArray(parsed) ||
      parsed.some(
        (item) =>
          !item ||
          typeof item.providerId !== "string" ||
          (item.type !== "api_key" && item.type !== "oauth"),
      )
    ) {
      throw new CredentialIndexCorruptError();
    }
    return parsed;
  }

  private async readIndexForReconcile(): Promise<boolean> {
    try {
      await this.readIndex();
      return false;
    } catch (error) {
      if (!(error instanceof CredentialIndexCorruptError)) throw error;
      const quarantined = join(
        dirname(this.indexPath),
        `credential-index.corrupt-${Date.now()}.json`,
      );
      try {
        await rename(this.indexPath, quarantined);
      } catch (renameError) {
        if ((renameError as NodeJS.ErrnoException)?.code !== "ENOENT") throw renameError;
      }
      return true;
    }
  }

  private enqueueProvider<T>(providerId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.providerChains.get(providerId) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(task);
    const tail = operation.then(
      () => undefined,
      () => undefined,
    );
    this.providerChains.set(providerId, tail);
    void tail.then(() => {
      if (this.providerChains.get(providerId) === tail) this.providerChains.delete(providerId);
    });
    return operation;
  }

  private enqueueIndex<T>(task: () => Promise<T>): Promise<T> {
    const operation = this.indexChain.then(task);
    this.indexChain = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
}

function account(providerId: string): string {
  return `${ACCOUNT_PREFIX}${providerId}`;
}

function throwIfAborted(options?: CredentialOperationOptions): void {
  if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

function parseCredential(value: string | null): StoredCredential | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as StoredCredential;
    if (parsed?.type === "api_key" || parsed?.type === "oauth") return parsed;
  } catch {
    return { type: "api_key", key: value };
  }
  return undefined;
}
