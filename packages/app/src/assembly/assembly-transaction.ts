export interface OwnedAgentResource {
  readonly label: string;
  readonly cleanup: () => void | Promise<void>;
}

export class AssemblyTransaction {
  private resources: OwnedAgentResource[] = [];
  private settled = false;

  defer(label: string, cleanup: () => void | Promise<void>): void {
    if (this.settled) throw new Error("Assembly transaction is already settled");
    this.resources.push({ label, cleanup });
  }

  commit(): readonly OwnedAgentResource[] {
    if (this.settled) throw new Error("Assembly transaction is already settled");
    this.settled = true;
    const resources = this.resources;
    this.resources = [];
    return resources;
  }

  async rollback(cause: unknown): Promise<never> {
    if (this.settled) throw new Error("Assembly transaction is already settled", { cause });
    this.settled = true;
    const failures: ResourceCleanupFailure[] = [];
    for (const resource of this.resources.reverse()) {
      try {
        await resource.cleanup();
      } catch (error) {
        failures.push({ resource: resource.label, error });
      }
    }
    this.resources = [];
    if (failures.length > 0) {
      throw new AssemblyRollbackError(cause, failures);
    }
    throw cause;
  }
}
import { AssemblyRollbackError, type ResourceCleanupFailure } from "./errors";
