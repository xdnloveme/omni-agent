import { rm } from "node:fs/promises";
import type { ContextSidecarLayout } from "./sidecarLayout";
import { createContextSidecarLock } from "./sidecarStore";

export class ContextSidecarLifecycle {
  constructor(private readonly layout: ContextSidecarLayout) {}

  async clear(sessionId: string): Promise<void> {
    await createContextSidecarLock(this.layout, sessionId).runExclusive(() =>
      rm(this.layout.contextDirectory(sessionId), { recursive: true, force: true }),
    );
  }
}
