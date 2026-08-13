import { randomUUID } from "node:crypto";
import { throwIfAborted } from "../../execution";
import type { DeepReadonly } from "../../data";
import type { TranscriptMessage } from "../../messages";
import type { ContextCheckpointStorePort } from "../checkpoints/ports";
import type { ContextCheckpoint } from "../checkpoints/types";
import type { ContextTokenEstimatorPort } from "../contracts/ports";
import type {
  ContextDecision,
  ContextFinalGateOptions,
  ContextFrame,
  ContextTokenEstimate,
} from "../contracts/types";
import { digestContextValue } from "../digest";
import { DEFAULT_CONTEXT_COMPRESSION_BUDGET } from "./budget";
import { toCheckpointEntry } from "./checkpointEntry";
import type { ContextSummaryGeneratorPort } from "./contracts";
import { partitionContextEntries } from "./partition";
import {
  CHECKPOINT_PROMPT_VERSION,
  CHECKPOINT_SYSTEM_PROMPT,
  createCheckpointUserPrompt,
} from "./prompt";

export interface CheckpointCompactionResult {
  readonly frame: ContextFrame;
  readonly decision: ContextDecision;
}

export class CheckpointCompactor {
  constructor(
    private readonly checkpoints: ContextCheckpointStorePort,
    private readonly summaries: ContextSummaryGeneratorPort,
    private readonly estimator: ContextTokenEstimatorPort,
  ) {}

  async compact(input: {
    readonly frame: ContextFrame;
    readonly estimate: ContextTokenEstimate;
    readonly messages: readonly TranscriptMessage[];
    readonly checkpoint?: ContextCheckpoint;
    readonly options: DeepReadonly<ContextFinalGateOptions>;
    readonly policyDigest: string;
    readonly gateName: string;
    readonly gateVersion: number;
  }): Promise<CheckpointCompactionResult> {
    const maxSummaryTokens = Math.max(
      1,
      Math.floor(
        input.estimate.usableInputBudget * DEFAULT_CONTEXT_COMPRESSION_BUDGET.summaryOutputRatio,
      ),
    );
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      throwIfAborted(input.options.signal);
      try {
        const partition = partitionContextEntries(
          input.frame.entries,
          tailBudget(input.estimate, attempt),
          this.estimator,
        );
        if (
          input.checkpoint &&
          partition.coveredMessageCount <= input.checkpoint.coveredMessageCount &&
          attempt === 0
        ) {
          continue;
        }
        const summaryModelCallId = `${input.options.modelCallId}:checkpoint:${attempt + 1}`;
        const result = await this.summaries.generate({
          agentId: input.options.agentId,
          sessionId: input.options.sessionId,
          systemPrompt: CHECKPOINT_SYSTEM_PROMPT,
          userPrompt: createCheckpointUserPrompt({
            previousSummary: input.checkpoint?.summary,
            entries: partition.coveredEntries.filter((entry) => entry.kind !== "checkpoint"),
            maxOutputTokens: maxSummaryTokens,
          }),
          maxOutputTokens: maxSummaryTokens,
          modelCallId: summaryModelCallId,
          signal: input.options.signal,
        });
        if (!result.summary.trim()) throw new Error("Checkpoint summary response was empty");
        const checkpoint = createCheckpoint({
          parent: input.checkpoint,
          sessionId: input.options.sessionId,
          sessionRevision: input.options.sessionRevision,
          middlewareDigest: input.options.middlewareDigest,
          policyDigest: input.policyDigest,
          gateName: input.gateName,
          gateVersion: input.gateVersion,
          coveredMessageCount: partition.coveredMessageCount,
          messages: input.messages,
          summary: result.summary,
          generatedBy: result,
          estimatedSummaryTokens: Math.ceil(result.summary.length / 4),
          summaryModelCallId,
        });
        const frame: ContextFrame = {
          ...input.frame,
          entries: [toCheckpointEntry(checkpoint), ...partition.tailEntries],
        };
        const estimate = this.estimator.estimate(frame);
        if (estimate.usageRatio > DEFAULT_CONTEXT_COMPRESSION_BUDGET.compressedTargetRatio) {
          throw new ContextCompressionTargetError(
            `Checkpoint context ratio ${estimate.usageRatio.toFixed(3)} exceeds target`,
          );
        }
        await this.persist(checkpoint);
        return {
          frame,
          decision: {
            type: input.checkpoint ? "checkpoint_extended" : "checkpoint_created",
            details: {
              checkpointId: checkpoint.id,
              parentId: checkpoint.parentId ?? null,
              coveredMessageCount: checkpoint.coveredMessageCount,
              attempt: attempt + 1,
              summaryModelCallId,
            },
          },
        };
      } catch (error) {
        if (error instanceof ContextCheckpointPersistenceError) throw error;
        lastError = error;
        throwIfAborted(input.options.signal);
      }
    }
    throw new ContextCompressionTargetError(
      `Unable to prepare checkpoint context after two attempts: ${errorMessage(lastError)}`,
    );
  }

  private async persist(checkpoint: ContextCheckpoint): Promise<void> {
    try {
      await this.checkpoints.append(checkpoint);
    } catch (error) {
      throw new ContextCheckpointPersistenceError(error);
    }
  }
}

export class ContextCompressionTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextCompressionTargetError";
  }
}

class ContextCheckpointPersistenceError extends Error {
  constructor(cause: unknown) {
    super(`Failed to persist context checkpoint: ${errorMessage(cause)}`, { cause });
    this.name = "ContextCheckpointPersistenceError";
  }
}

function tailBudget(estimate: ContextTokenEstimate, attempt: number): number {
  if (attempt > 0) return 0;
  return Math.floor(
    estimate.usableInputBudget *
      (DEFAULT_CONTEXT_COMPRESSION_BUDGET.compressedTargetRatio -
        DEFAULT_CONTEXT_COMPRESSION_BUDGET.summaryOutputRatio -
        0.05),
  );
}

function createCheckpoint(input: {
  readonly parent?: ContextCheckpoint;
  readonly sessionId: string;
  readonly sessionRevision: number;
  readonly middlewareDigest: string;
  readonly policyDigest: string;
  readonly gateName: string;
  readonly gateVersion: number;
  readonly coveredMessageCount: number;
  readonly messages: readonly TranscriptMessage[];
  readonly summary: string;
  readonly generatedBy: {
    readonly provider: string;
    readonly model: string;
    readonly responseModel?: string;
  };
  readonly estimatedSummaryTokens: number;
  readonly summaryModelCallId: string;
}): ContextCheckpoint {
  return {
    id: randomUUID(),
    parentId: input.parent?.id,
    sessionId: input.sessionId,
    sessionRevision: input.sessionRevision,
    coveredMessageCount: input.coveredMessageCount,
    coveredTranscriptDigest: digestContextValue(input.messages.slice(0, input.coveredMessageCount)),
    sourceMiddlewareDigest: input.middlewareDigest,
    sourcePolicyDigest: input.policyDigest,
    gateName: input.gateName,
    gateVersion: input.gateVersion,
    promptVersion: CHECKPOINT_PROMPT_VERSION,
    summary: input.summary,
    summaryDigest: digestContextValue(input.summary),
    estimatedSummaryTokens: input.estimatedSummaryTokens,
    summaryModelCallId: input.summaryModelCallId,
    generatedBy: { ...input.generatedBy },
    createdAt: new Date().toISOString(),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
