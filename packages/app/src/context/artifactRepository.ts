import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  InterprocessFileLock,
  type ContextArtifactStorePort,
  type ContextArtifactWriteRequest,
} from "@omni-agent/core";
import type { AgentStorageLayout } from "./storageLayout";

export class ContextArtifactRepository implements ContextArtifactStorePort {
  constructor(private readonly layout: AgentStorageLayout) {}

  async write(request: ContextArtifactWriteRequest): Promise<string> {
    const path = this.layout.toolResultArtifactPath(request.sessionId, request.artifactId);
    await this.lock(request.sessionId).runExclusive(async () => {
      await mkdir(dirname(path), { recursive: true });
      try {
        await writeFile(path, request.content, { encoding: "utf8", mode: 0o600, flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if ((await readFile(path, "utf8")) !== request.content) {
          throw new Error(`Context artifact digest collision: ${request.artifactId}`);
        }
      }
    });
    return path;
  }

  private lock(sessionId: string): InterprocessFileLock {
    return new InterprocessFileLock(this.layout.contextLockPath(sessionId), {
      retryMs: 25,
      timeoutMs: 5_000,
    });
  }
}
