import { homedir } from "node:os";
import { join } from "node:path";
import { InterprocessFileLock } from "@omni-agent/core";
import { AtomicJsonFile } from "../persistence/atomic-json-file";
import { migrateExecutionSettingsV4 } from "./migrations/migrate-execution-v4-to-v5";
import { migrateExecutionSettingsV5 } from "./migrations/migrate-execution-v5-to-v6";
import {
  EMPTY_EXECUTION_SETTINGS,
  isPersistedExecutionSettings,
  isPersistedExecutionSettingsV4,
  isPersistedExecutionSettingsV5,
  type PersistedExecutionSettings,
  type PersistedExecutionSettingsV5,
} from "./persisted-types";

export class ExecutionSettingsRepository {
  readonly path: string;
  readonly legacyPermissionsPath: string;
  readonly diagnostics: string[] = [];
  private readonly lock: InterprocessFileLock;
  private writes: Promise<void> = Promise.resolve();

  constructor(globalDirectory = join(homedir(), ".omni-agent")) {
    this.path = join(globalDirectory, "execution-settings.json");
    this.legacyPermissionsPath = join(globalDirectory, "permissions.json");
    this.lock = new InterprocessFileLock(`${this.path}.lock`);
  }

  async read(): Promise<PersistedExecutionSettings | undefined> {
    const value = await this.readCurrentFile();
    if (value === undefined) return undefined;
    if (isPersistedExecutionSettings(value)) return value;
    if (isPersistedExecutionSettingsV5(value) || isPersistedExecutionSettingsV4(value)) {
      return this.migrateToV6();
    }
    this.reportInvalidSettings();
    return structuredClone(EMPTY_EXECUTION_SETTINGS);
  }

  async readLegacyPermissions(): Promise<unknown> {
    try {
      return await new AtomicJsonFile<unknown>(this.legacyPermissionsPath).read();
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      this.reportDiagnostic("Legacy permissions are invalid; ignoring migration input.");
      return undefined;
    }
  }

  update(
    mutator: (value: PersistedExecutionSettings) => PersistedExecutionSettings,
  ): Promise<void> {
    return this.enqueueWrite(async () => {
      const raw = await this.readCurrentFile();
      const next = mutator(currentSettings(raw));
      if (!isPersistedExecutionSettings(next)) {
        throw new Error("Execution settings update produced an invalid configuration");
      }
      await new AtomicJsonFile<PersistedExecutionSettings>(this.path).write(next);
    });
  }

  private async migrateToV6(): Promise<PersistedExecutionSettings> {
    let migrated: PersistedExecutionSettings | undefined;
    try {
      await this.enqueueWrite(async () => {
        const raw = await new AtomicJsonFile<unknown>(this.path).read();
        if (isPersistedExecutionSettings(raw)) {
          migrated = raw;
          return;
        }
        let sourceVersion: 4 | 5;
        let version5: PersistedExecutionSettingsV5;
        if (isPersistedExecutionSettingsV5(raw)) {
          sourceVersion = 5;
          version5 = raw;
        } else if (isPersistedExecutionSettingsV4(raw)) {
          sourceVersion = 4;
          version5 = migrateExecutionSettingsV4(raw);
        } else {
          throw new Error("Execution settings changed while migrating to version 6");
        }
        const migration = migrateExecutionSettingsV5(version5);
        migrated = migration.settings;
        await new AtomicJsonFile<PersistedExecutionSettings>(this.path).write(migrated);
        this.reportDiagnostic(
          `Migrated execution settings from version ${sourceVersion} to version 6.`,
        );
        if (migration.discardedCoarseNetworkGrants > 0) {
          this.reportDiagnostic(
            `coarse_network_grant_discarded: Discarded ${migration.discardedCoarseNetworkGrants} coarse network grant(s) while migrating to target-scoped network access.`,
          );
        }
      });
      return migrated!;
    } catch {
      this.reportDiagnostic("Execution settings migration failed; using controlled defaults.");
      return structuredClone(EMPTY_EXECUTION_SETTINGS);
    }
  }

  private async readCurrentFile(): Promise<unknown> {
    try {
      return await new AtomicJsonFile<unknown>(this.path).read();
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      this.reportInvalidSettings();
      return structuredClone(EMPTY_EXECUTION_SETTINGS);
    }
  }

  private reportInvalidSettings(): void {
    this.reportDiagnostic("Execution settings are invalid; using controlled defaults.");
  }

  private reportDiagnostic(diagnostic: string): void {
    if (!this.diagnostics.includes(diagnostic)) this.diagnostics.push(diagnostic);
  }

  private enqueueWrite(operation: () => Promise<void>): Promise<void> {
    const queued = this.writes.then(() => this.lock.runExclusive(operation));
    this.writes = queued.catch(() => undefined);
    return queued;
  }
}

function currentSettings(value: unknown): PersistedExecutionSettings {
  if (isPersistedExecutionSettings(value)) return value;
  if (isPersistedExecutionSettingsV5(value)) return migrateExecutionSettingsV5(value).settings;
  if (isPersistedExecutionSettingsV4(value)) {
    return migrateExecutionSettingsV5(migrateExecutionSettingsV4(value)).settings;
  }
  return structuredClone(EMPTY_EXECUTION_SETTINGS);
}
