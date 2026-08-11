import { homedir } from "node:os";
import { join } from "node:path";
import { InterprocessFileLock } from "@omni-agent/core";
import { AtomicJsonFile } from "../persistence/atomic-json-file";
import {
  EMPTY_PERMISSIONS,
  isPersistedPermissions,
  type PersistedPermissions,
} from "./persisted-types";
import { migratePermissionsV1ToV2 } from "./migrations/migrate-permissions-v1-to-v2";

export interface PermissionRepositoryOptions {
  globalDirectory?: string;
}

export class PermissionRepository {
  readonly path: string;
  readonly diagnostics: string[] = [];
  private readonly lockPath: string;
  private readonly lock: InterprocessFileLock;
  private writes: Promise<void> = Promise.resolve();

  constructor(options: PermissionRepositoryOptions = {}) {
    const directory = options.globalDirectory ?? join(homedir(), ".omni-agent");
    this.path = join(directory, "permissions.json");
    this.lockPath = `${this.path}.lock`;
    this.lock = new InterprocessFileLock(this.lockPath);
  }

  async read(): Promise<PersistedPermissions | undefined> {
    this.diagnostics.length = 0;
    const value = await new AtomicJsonFile<unknown>(this.path).read();
    if (value === undefined) return undefined;
    if (isPersistedPermissions(value)) return value;
    const migration = migratePermissionsV1ToV2(value);
    if (!migration) throw new Error("Permission configuration format is invalid");
    return this.lock.runExclusive(async () => {
      const latest = await new AtomicJsonFile<unknown>(this.path).read();
      if (isPersistedPermissions(latest)) return latest;
      const currentMigration = migratePermissionsV1ToV2(latest);
      if (!currentMigration) throw new Error("Permission configuration format is invalid");
      this.recordMigrationDiagnostics(currentMigration.droppedIdentities);
      await new AtomicJsonFile<PersistedPermissions>(this.path).write(currentMigration.value);
      return currentMigration.value;
    });
  }

  update(mutator: (current: PersistedPermissions) => PersistedPermissions): Promise<void> {
    const operation = this.writes.then(() =>
      this.lock.runExclusive(async () => {
        const raw = await new AtomicJsonFile<unknown>(this.path).read();
        const current = this.toWritablePermissions(raw);
        const next = mutator(current);
        if (!isPersistedPermissions(next)) {
          throw new Error("Permission update produced an invalid configuration");
        }
        await new AtomicJsonFile<PersistedPermissions>(this.path).write(next);
      }),
    );
    this.writes = operation.catch(() => undefined);
    return operation;
  }

  private recordMigrationDiagnostics(droppedIdentities: readonly string[]): void {
    for (const identity of droppedIdentities) {
      this.diagnostics.push(`Dropped unrecognized v1 tool identity: ${identity}`);
    }
  }

  private toWritablePermissions(raw: unknown): PersistedPermissions {
    if (raw === undefined) return structuredClone(EMPTY_PERMISSIONS);
    if (isPersistedPermissions(raw)) return raw;
    const migration = migratePermissionsV1ToV2(raw);
    if (!migration) throw new Error("Permission configuration format is invalid");
    this.recordMigrationDiagnostics(migration.droppedIdentities);
    return migration.value;
  }
}
