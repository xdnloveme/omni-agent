import { throwIfAborted } from "../../execution";
import { cloneTranscriptMessages } from "../../messages";
import type { ContextCheckpointStorePort } from "../checkpoints/ports";
import { resolveCompatibleCheckpoint } from "../checkpoints/resolver";
import type { ContextFinalGatePort, ContextTokenEstimatorPort } from "../contracts/ports";
import type { ContextPolicyStageResult } from "../contracts/types";
import { digestContextValue } from "../digest";
import { cloneContextFrame } from "../policy/types";
import { DEFAULT_CONTEXT_COMPRESSION_BUDGET } from "./budget";
import { CheckpointCompactor } from "./checkpointCompactor";
import { restoreCheckpoint } from "./checkpointEntry";
import type { ContextSummaryGeneratorPort } from "./contracts";
import { CHECKPOINT_PROMPT_VERSION } from "./prompt";

export {
  ContextCompressionTargetError,
  ContextSummaryInputBudgetError,
} from "./checkpointCompactor";

export class HeavyCheckpointGateStage implements ContextFinalGatePort {
  readonly name = "heavy_checkpoint_gate";
  readonly version = 1;
  private readonly compactor: CheckpointCompactor;

  constructor(
    private readonly checkpoints: ContextCheckpointStorePort,
    summaries: ContextSummaryGeneratorPort,
    private readonly estimator: ContextTokenEstimatorPort,
  ) {
    this.compactor = new CheckpointCompactor(checkpoints, summaries, estimator);
  }

  async apply(
    frame: Parameters<ContextFinalGatePort["apply"]>[0],
    options: Parameters<ContextFinalGatePort["apply"]>[1],
  ): Promise<ContextPolicyStageResult> {
    throwIfAborted(options.signal);
    const owned = cloneContextFrame(frame);
    const messages = cloneTranscriptMessages(options.sourceMessages);
    const policyDigest = digestContextValue(options.precedingStages);
    const checkpoint = resolveCompatibleCheckpoint({
      checkpoints: await this.checkpoints.list(options.sessionId),
      sessionId: options.sessionId,
      messages,
      middlewareDigest: options.middlewareDigest,
      policyDigest,
      gateName: this.name,
      gateVersion: this.version,
      promptVersion: CHECKPOINT_PROMPT_VERSION,
    });
    const restored = checkpoint ? restoreCheckpoint(owned, checkpoint) : owned;
    const estimate = this.estimator.estimate(restored);
    if (estimate.usageRatio < DEFAULT_CONTEXT_COMPRESSION_BUDGET.heavyTriggerRatio) {
      return {
        frame: restored,
        decisions: [
          checkpoint
            ? { type: "checkpoint_reused", details: { checkpointId: checkpoint.id } }
            : { type: "heavy_checkpoint_skipped", details: { reason: "below_threshold" } },
        ],
      };
    }

    options.compression.begin("heavy_checkpoint", {
      inputTokens: estimate.totalInputTokens,
      usableInputBudget: estimate.usableInputBudget,
      thresholdTokens: Math.ceil(
        estimate.usableInputBudget * DEFAULT_CONTEXT_COMPRESSION_BUDGET.heavyTriggerRatio,
      ),
    });
    const result = await this.compactor.compact({
      frame: restored,
      estimate,
      messages,
      checkpoint,
      options,
      policyDigest,
      gateName: this.name,
      gateVersion: this.version,
    });
    options.compression.record({ kind: "heavy_checkpoint", ...result.operation });
    return { frame: result.frame, decisions: [result.decision] };
  }
}
