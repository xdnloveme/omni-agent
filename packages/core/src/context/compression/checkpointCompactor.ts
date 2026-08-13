import { randomUUID } from "node:crypto";
import { isAbortError, throwIfAborted } from "../../execution";
import type { DeepReadonly } from "../../data";
import type { TranscriptMessage } from "../../messages";
import type { ContextCheckpointStorePort } from "../checkpoints/ports";
import type { ContextCheckpoint } from "../checkpoints/types";
import type { ContextTokenEstimatorPort } from "../contracts/ports";
import type {
  ContextDecision,
  ContextEntry,
  ContextFinalGateOptions,
  ContextFrame,
  ContextTokenEstimate,
} from "../contracts/types";
import { digestContextValue } from "../digest";
import { estimateContextTextTokens } from "../tokenEstimate";
import { DEFAULT_CONTEXT_COMPRESSION_BUDGET } from "./budget";
import { toCheckpointEntry } from "./checkpointEntry";
import type { ContextSummaryGeneratorPort, ContextSummaryRequest } from "./contracts";
import { partitionContextEntries } from "./partition";
import {
  CHECKPOINT_PROMPT_VERSION,
  CHECKPOINT_SYSTEM_PROMPT,
  createCheckpointSourceEntries,
  createCheckpointUserPrompt,
} from "./prompt";
import { validateCheckpointSummary } from "./summary";

const SUMMARY_INPUT_SAFETY_BUFFER_TOKENS = 1_024;

export interface CheckpointCompactionResult {
  readonly frame: ContextFrame;
  readonly decision: ContextDecision;
  readonly operation: {
    readonly action: "create" | "extend";
    readonly affectedCount: number;
  };
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
    throwIfAborted(input.options.signal);
    const maxSummaryTokens = Math.max(
      1,
      Math.floor(
        input.estimate.usableInputBudget * DEFAULT_CONTEXT_COMPRESSION_BUDGET.summaryOutputRatio,
      ),
    );
    const partition = partitionContextEntries(
      input.frame.entries,
      tailBudget(input.estimate),
      this.estimator,
      input.checkpoint?.coveredMessageCount,
    );
    const summaryModelCallId = `${input.options.modelCallId}:checkpoint`;
    const request = createSummaryRequest({
      agentId: input.options.agentId,
      sessionId: input.options.sessionId,
      modelCallId: summaryModelCallId,
      previousSummary: input.checkpoint?.summary,
      coveredEntries: partition.coveredEntries,
      maxOutputTokens: maxSummaryTokens,
      contextWindow: input.frame.model.contextWindow,
      signal: input.options.signal,
    });

    let lastError: unknown;
    let prepared:
      | {
          readonly checkpoint: ContextCheckpoint;
          readonly frame: ContextFrame;
          readonly attempt: number;
        }
      | undefined;
    for (let attempt = 1; attempt <= 2; attempt++) {
      throwIfAborted(input.options.signal);
      try {
        const result = await this.summaries.generate(request);
        const summary = validateCheckpointSummary(result.summary, maxSummaryTokens);
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
          summary: summary.body,
          generatedBy: result,
          estimatedSummaryTokens: summary.estimatedTokens,
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
        prepared = { checkpoint, frame, attempt };
        break;
      } catch (error) {
        if (isAbortError(error)) throw error;
        lastError = error;
        throwIfAborted(input.options.signal);
      }
    }
    if (!prepared) {
      throw new ContextCompressionTargetError(
        `Unable to prepare checkpoint context after two attempts: ${errorMessage(lastError)}`,
      );
    }
    try {
      await this.checkpoints.append(prepared.checkpoint);
    } catch (error) {
      throw new Error(`Failed to persist context checkpoint: ${errorMessage(error)}`, {
        cause: error,
      });
    }
    return {
      frame: prepared.frame,
      operation: {
        action: input.checkpoint ? "extend" : "create",
        affectedCount:
          prepared.checkpoint.coveredMessageCount - (input.checkpoint?.coveredMessageCount ?? 0),
      },
      decision: {
        type: input.checkpoint ? "checkpoint_extended" : "checkpoint_created",
        details: {
          checkpointId: prepared.checkpoint.id,
          parentId: prepared.checkpoint.parentId ?? null,
          coveredMessageCount: prepared.checkpoint.coveredMessageCount,
          attempt: prepared.attempt,
          summaryModelCallId,
        },
      },
    };
  }
}

export class ContextCompressionTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextCompressionTargetError";
  }
}

export class ContextSummaryInputBudgetError extends Error {
  constructor(estimatedInputTokens: number, inputLimit: number) {
    super(
      `Checkpoint summary input estimate ${estimatedInputTokens} exceeds input limit ${inputLimit}`,
    );
    this.name = "ContextSummaryInputBudgetError";
  }
}

function tailBudget(estimate: ContextTokenEstimate): number {
  return Math.floor(
    estimate.usableInputBudget *
      (DEFAULT_CONTEXT_COMPRESSION_BUDGET.compressedTargetRatio -
        DEFAULT_CONTEXT_COMPRESSION_BUDGET.summaryOutputRatio -
        0.05),
  );
}

function createSummaryRequest(input: {
  readonly agentId: string;
  readonly sessionId: string;
  readonly modelCallId: string;
  readonly previousSummary?: string;
  readonly coveredEntries: readonly ContextEntry[];
  readonly maxOutputTokens: number;
  readonly contextWindow: number;
  readonly signal?: AbortSignal;
}): Readonly<ContextSummaryRequest> {
  const userPrompt = createCheckpointUserPrompt({
    previousSummary: input.previousSummary,
    entries: createCheckpointSourceEntries(input.coveredEntries),
    maxOutputTokens: input.maxOutputTokens,
  });
  const estimatedInputTokens =
    estimateContextTextTokens(CHECKPOINT_SYSTEM_PROMPT) +
    estimateContextTextTokens(userPrompt) +
    16;
  const inputLimit =
    input.contextWindow - input.maxOutputTokens - SUMMARY_INPUT_SAFETY_BUFFER_TOKENS;
  if (estimatedInputTokens > inputLimit) {
    throw new ContextSummaryInputBudgetError(estimatedInputTokens, inputLimit);
  }
  return Object.freeze({
    agentId: input.agentId,
    sessionId: input.sessionId,
    systemPrompt: CHECKPOINT_SYSTEM_PROMPT,
    userPrompt,
    maxOutputTokens: input.maxOutputTokens,
    modelCallId: input.modelCallId,
    signal: input.signal,
  });
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
