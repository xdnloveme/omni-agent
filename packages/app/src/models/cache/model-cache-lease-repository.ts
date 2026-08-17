import { join } from "node:path";
import { assertModelCacheLeaseSnapshot } from "@omni-agent/models";
import { AtomicJsonFile } from "../../persistence/atomic-json-file";
import type { ContextSidecarLayout } from "../../context/sidecarLayout";
import { createContextSidecarLock, readValidatedSidecar } from "../../context/sidecarStore";

export class ModelCacheLeaseRepository {
  constructor(
    private readonly layout: ContextSidecarLayout,
    private readonly onDiagnostic?: (message: string) => void,
  ) {}

  async load(sessionId: string): Promise<unknown | undefined> {
    return this.lock(sessionId).runExclusive(() => {
      const path = this.path(sessionId);
      return readValidatedSidecar({
        file: new AtomicJsonFile<unknown>(path),
        path,
        validate: (value): asserts value is unknown => assertModelCacheLeaseSnapshot(value),
        label: "Model cache lease sidecar",
        onDiagnostic: this.onDiagnostic,
      });
    });
  }

  async save(sessionId: string, snapshot: unknown): Promise<void> {
    assertModelCacheLeaseSnapshot(snapshot);
    await this.lock(sessionId).runExclusive(() =>
      new AtomicJsonFile<unknown>(this.path(sessionId)).write(snapshot),
    );
  }

  private path(sessionId: string): string {
    return join(this.layout.contextDirectory(sessionId), "cache-lease.json");
  }

  private lock(sessionId: string) {
    return createContextSidecarLock(this.layout, sessionId);
  }
}
