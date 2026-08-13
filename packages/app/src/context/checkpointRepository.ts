import { rename } from "node:fs/promises";
import {
  InterprocessFileLock,
  type ContextCheckpoint,
  type ContextCheckpointStorePort,
} from "@omni-agent/core";
import { AtomicJsonFile } from "../persistence/atomic-json-file";
import type { AgentStorageLayout } from "./storageLayout";

interface PersistedCheckpoints {
  readonly version: 1;
  readonly checkpoints: readonly ContextCheckpoint[];
}

export class ContextCheckpointRepository implements ContextCheckpointStorePort {
  constructor(
    private readonly layout: AgentStorageLayout,
    private readonly onDiagnostic?: (message: string) => void,
  ) {}

  async list(sessionId: string): Promise<readonly ContextCheckpoint[]> {
    return this.lock(sessionId).runExclusive(async () => {
      const value = await this.readOrQuarantine(sessionId);
      return value.checkpoints.map(cloneCheckpoint);
    });
  }

  async append(checkpoint: ContextCheckpoint): Promise<void> {
    await this.lock(checkpoint.sessionId).runExclusive(async () => {
      const current = await this.readOrQuarantine(checkpoint.sessionId);
      if (current.checkpoints.some((entry) => entry.id === checkpoint.id)) return;
      await this.file(checkpoint.sessionId).write({
        version: 1,
        checkpoints: [...current.checkpoints.map(cloneCheckpoint), cloneCheckpoint(checkpoint)],
      });
    });
  }

  private async readOrQuarantine(sessionId: string): Promise<PersistedCheckpoints> {
    try {
      const value = await this.file(sessionId).read();
      if (value === undefined) return { version: 1, checkpoints: [] };
      assertPersistedCheckpoints(value, sessionId);
      return value;
    } catch (error) {
      const path = this.layout.checkpointPath(sessionId);
      const quarantine = `${path}.corrupt-${Date.now()}`;
      try {
        await rename(path, quarantine);
      } catch (renameError) {
        if ((renameError as NodeJS.ErrnoException).code !== "ENOENT") throw renameError;
      }
      this.onDiagnostic?.(
        `Context checkpoint sidecar was corrupt and quarantined: ${errorMessage(error)}`,
      );
      return { version: 1, checkpoints: [] };
    }
  }

  private file(sessionId: string): AtomicJsonFile<PersistedCheckpoints> {
    return new AtomicJsonFile(this.layout.checkpointPath(sessionId));
  }

  private lock(sessionId: string): InterprocessFileLock {
    return new InterprocessFileLock(this.layout.contextLockPath(sessionId), {
      retryMs: 25,
      timeoutMs: 5_000,
    });
  }
}

function assertPersistedCheckpoints(
  value: unknown,
  sessionId: string,
): asserts value is PersistedCheckpoints {
  if (!value || typeof value !== "object") throw new Error("Invalid checkpoint sidecar");
  const candidate = value as Partial<PersistedCheckpoints>;
  if (candidate.version !== 1 || !Array.isArray(candidate.checkpoints)) {
    throw new Error("Unsupported checkpoint sidecar schema");
  }
  for (const checkpoint of candidate.checkpoints) {
    if (
      !checkpoint ||
      typeof checkpoint !== "object" ||
      typeof checkpoint.id !== "string" ||
      checkpoint.sessionId !== sessionId ||
      !Number.isInteger(checkpoint.sessionRevision) ||
      !Number.isInteger(checkpoint.coveredMessageCount) ||
      typeof checkpoint.coveredTranscriptDigest !== "string" ||
      typeof checkpoint.sourceMiddlewareDigest !== "string" ||
      typeof checkpoint.sourcePolicyDigest !== "string" ||
      typeof checkpoint.gateName !== "string" ||
      !Number.isInteger(checkpoint.gateVersion) ||
      !Number.isInteger(checkpoint.promptVersion) ||
      typeof checkpoint.summary !== "string" ||
      typeof checkpoint.summaryDigest !== "string" ||
      !Number.isInteger(checkpoint.estimatedSummaryTokens) ||
      typeof checkpoint.summaryModelCallId !== "string" ||
      !checkpoint.generatedBy ||
      typeof checkpoint.generatedBy.provider !== "string" ||
      typeof checkpoint.generatedBy.model !== "string" ||
      typeof checkpoint.createdAt !== "string" ||
      (checkpoint.parentId !== undefined && typeof checkpoint.parentId !== "string")
    ) {
      throw new Error("Invalid checkpoint record");
    }
  }
}

function cloneCheckpoint(checkpoint: ContextCheckpoint): ContextCheckpoint {
  return { ...checkpoint, generatedBy: { ...checkpoint.generatedBy } };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
