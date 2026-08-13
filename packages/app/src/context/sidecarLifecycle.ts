import { rm } from "node:fs/promises";
import { InterprocessFileLock } from "@omni-agent/core";
import type { AgentStorageLayout } from "./storageLayout";

export class ContextSidecarLifecycle {
  constructor(private readonly layout: AgentStorageLayout) {}

  async clear(sessionId: string): Promise<void> {
    await new InterprocessFileLock(this.layout.contextLockPath(sessionId), {
      retryMs: 25,
      timeoutMs: 5_000,
    }).runExclusive(() =>
      rm(this.layout.contextDirectory(sessionId), { recursive: true, force: true }),
    );
  }
}
