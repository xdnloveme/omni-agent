import { homedir } from "node:os";
import { join } from "node:path";
import { InterprocessFileLock } from "@omni-agent/core";
import { AtomicJsonFile } from "../persistence/atomic-json-file";
import { migrateExecutionSettingsV4 } from "./migrations/migrate-execution-v4-to-v5";
import {
  EMPTY_EXECUTION_SETTINGS,
  isPersistedExecutionSettings,
  isPersistedExecutionSettingsV4,
  type PersistedExecutionSettings,
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
    if (isPersistedExecutionSettingsV4(value)) return this.migrateV4();
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

  private async migrateV4(): Promise<PersistedExecutionSettings> {
    let migrated: PersistedExecutionSettings | undefined;
    try {
      await this.enqueueWrite(async () => {
        const raw = await new AtomicJsonFile<unknown>(this.path).read();
        if (isPersistedExecutionSettings(raw)) {
          migrated = raw;
          return;
        }
        if (!isPersistedExecutionSettingsV4(raw)) {
          throw new Error("Execution settings changed while migrating version 4");
        }
        migrated = migrateExecutionSettingsV4(raw);
        await new AtomicJsonFile<PersistedExecutionSettings>(this.path).write(migrated);
        this.reportDiagnostic("Migrated execution settings from version 4 to version 5.");
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
  if (isPersistedExecutionSettingsV4(value)) return migrateExecutionSettingsV4(value);
  return structuredClone(EMPTY_EXECUTION_SETTINGS);
}
