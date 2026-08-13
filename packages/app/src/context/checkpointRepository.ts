import {
  digestContextValue,
  type ContextCheckpoint,
  type ContextCheckpointStorePort,
} from "@omni-agent/core";
import { AtomicJsonFile } from "../persistence/atomic-json-file";
import type { ContextSidecarLayout } from "./sidecarLayout";
import { createContextSidecarLock, readValidatedSidecar } from "./sidecarStore";

interface PersistedCheckpoints {
  readonly version: 1;
  readonly checkpoints: readonly ContextCheckpoint[];
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export class ContextCheckpointRepository implements ContextCheckpointStorePort {
  constructor(
    private readonly layout: ContextSidecarLayout,
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
      assertCheckpointRecord(checkpoint, checkpoint.sessionId);
      const existing = current.checkpoints.find((entry) => entry.id === checkpoint.id);
      if (existing) {
        if (digestContextValue(existing) === digestContextValue(checkpoint)) return;
        throw new Error(`Context checkpoint id conflict: ${checkpoint.id}`);
      }
      assertCheckpointParent(
        checkpoint,
        checkpoint.parentId
          ? current.checkpoints.find((entry) => entry.id === checkpoint.parentId)
          : undefined,
      );
      await this.file(checkpoint.sessionId).write({
        version: 1,
        checkpoints: [...current.checkpoints.map(cloneCheckpoint), cloneCheckpoint(checkpoint)],
      });
    });
  }

  private async readOrQuarantine(sessionId: string): Promise<PersistedCheckpoints> {
    const file = this.file(sessionId);
    return (
      (await readValidatedSidecar({
        file,
        path: this.layout.checkpointPath(sessionId),
        validate: (value): asserts value is PersistedCheckpoints =>
          assertPersistedCheckpoints(value, sessionId),
        label: "Context checkpoint sidecar",
        onDiagnostic: this.onDiagnostic,
      })) ?? { version: 1, checkpoints: [] }
    );
  }

  private file(sessionId: string): AtomicJsonFile<PersistedCheckpoints> {
    return new AtomicJsonFile(this.layout.checkpointPath(sessionId));
  }

  private lock(sessionId: string) {
    return createContextSidecarLock(this.layout, sessionId);
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
  const seen = new Map<string, ContextCheckpoint>();
  for (const checkpoint of candidate.checkpoints) {
    assertCheckpointRecord(checkpoint, sessionId);
    if (seen.has(checkpoint.id)) throw new Error(`Duplicate checkpoint id: ${checkpoint.id}`);
    assertCheckpointParent(
      checkpoint,
      checkpoint.parentId ? seen.get(checkpoint.parentId) : undefined,
    );
    seen.set(checkpoint.id, checkpoint);
  }
}

function assertCheckpointRecord(
  value: unknown,
  sessionId: string,
): asserts value is ContextCheckpoint {
  if (!value || typeof value !== "object") throw new Error("Invalid checkpoint record");
  const checkpoint = value as Partial<ContextCheckpoint>;
  if (
    !isNonEmpty(checkpoint.id) ||
    checkpoint.sessionId !== sessionId ||
    !isNonNegativeInteger(checkpoint.sessionRevision) ||
    !isNonNegativeInteger(checkpoint.coveredMessageCount) ||
    !isDigest(checkpoint.coveredTranscriptDigest) ||
    !isDigest(checkpoint.sourceMiddlewareDigest) ||
    !isDigest(checkpoint.sourcePolicyDigest) ||
    !isNonEmpty(checkpoint.gateName) ||
    !isNonNegativeInteger(checkpoint.gateVersion) ||
    !isNonNegativeInteger(checkpoint.promptVersion) ||
    !isNonEmpty(checkpoint.summary) ||
    !isDigest(checkpoint.summaryDigest) ||
    checkpoint.summaryDigest !== digestContextValue(checkpoint.summary) ||
    !isNonNegativeInteger(checkpoint.estimatedSummaryTokens) ||
    !isNonEmpty(checkpoint.summaryModelCallId) ||
    !checkpoint.generatedBy ||
    !isNonEmpty(checkpoint.generatedBy.provider) ||
    !isNonEmpty(checkpoint.generatedBy.model) ||
    (checkpoint.generatedBy.responseModel !== undefined &&
      !isNonEmpty(checkpoint.generatedBy.responseModel)) ||
    !isIsoTimestamp(checkpoint.createdAt) ||
    (checkpoint.parentId !== undefined && !isNonEmpty(checkpoint.parentId)) ||
    checkpoint.parentId === checkpoint.id
  ) {
    throw new Error("Invalid checkpoint record");
  }
}

function assertCheckpointParent(
  checkpoint: ContextCheckpoint,
  parent: ContextCheckpoint | undefined,
): void {
  if (!checkpoint.parentId) return;
  if (!parent) throw new Error(`Missing checkpoint parent: ${checkpoint.parentId}`);
  if (checkpoint.coveredMessageCount <= parent.coveredMessageCount) {
    throw new Error("Checkpoint coverage must increase from its parent");
  }
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function cloneCheckpoint(checkpoint: ContextCheckpoint): ContextCheckpoint {
  return { ...checkpoint, generatedBy: { ...checkpoint.generatedBy } };
}
