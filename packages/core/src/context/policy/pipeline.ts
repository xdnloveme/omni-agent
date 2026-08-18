import { throwIfAborted } from "../../execution";
import type { DeepReadonly } from "../../data";
import { cloneTranscriptMessages } from "../../messages";
import type {
  ContextFinalGatePort,
  ContextPolicyPort,
  ContextPolicyStagePort,
  ContextTokenEstimatorPort,
} from "../contracts/ports";
import type {
  ContextDecision,
  ContextEnvelope,
  ContextHistoryFrame,
  ContextPolicyResult,
} from "../contracts/types";
import { cloneContextDecisions, cloneContextEnvelope, cloneContextHistoryFrame } from "./types";
import {
  assertPolicyComponent,
  assertPolicyStageResult,
  InvalidContextPolicyResultError,
} from "./validator";
import { ContextCompressionProgressCollector } from "./compressionProgress";

export { InvalidContextPolicyResultError, assertContextPolicyResult } from "./validator";

export class ContextPolicyPipeline implements ContextPolicyPort {
  constructor(
    private readonly stages: readonly ContextPolicyStagePort[],
    private readonly finalGate: ContextFinalGatePort,
    private readonly estimator: ContextTokenEstimatorPort,
  ) {}

  async resolve(
    envelope: ContextEnvelope,
    options: Parameters<ContextPolicyPort["resolve"]>[1],
  ): Promise<ContextPolicyResult> {
    const fixed = cloneContextEnvelope(envelope).fixed;
    let current = cloneContextHistoryFrame(envelope.history);
    const estimateHistory = (history: DeepReadonly<ContextHistoryFrame>) =>
      this.estimator.estimate({ fixed, history });
    let estimate = estimateHistory(current);
    const compression = new ContextCompressionProgressCollector(
      options.modelCallId,
      options.progress,
      estimate,
    );
    const decisions: ContextDecision[] = [];
    const manifests: ContextPolicyResult["stages"][number][] = [];

    try {
      for (const stage of this.stages) {
        throwIfAborted(options.signal);
        assertPolicyComponent(stage);
        const before = estimate;
        const input = cloneContextHistoryFrame(current);
        const result = await stage.apply(input, {
          agentId: options.agentId,
          sessionId: options.sessionId,
          modelCallId: options.modelCallId,
          estimate: { ...before },
          estimateHistory,
          estimateEntry: (entry) => this.estimator.estimateEntry(entry),
          compression,
          signal: options.signal,
        });
        if (result.frame === input) {
          throw new InvalidContextPolicyResultError(
            `Context policy stage must return a new frame: ${stage.name}`,
          );
        }
        assertPolicyStageResult(result, stage.name);
        current = cloneContextHistoryFrame(result.frame);
        estimate = estimateHistory(current);
        decisions.push(...cloneContextDecisions(result.decisions));
        manifests.push({
          name: stage.name,
          version: stage.version,
          ...(stage.configurationDigest
            ? { configurationDigest: stage.configurationDigest() }
            : {}),
          before,
          after: estimate,
        });
      }

      throwIfAborted(options.signal);
      assertPolicyComponent(this.finalGate);
      const before = estimate;
      const gateInput = cloneContextHistoryFrame(current);
      const gateResult = await this.finalGate.apply(gateInput, {
        model: { ...fixed.model },
        agentId: options.agentId,
        sessionId: options.sessionId,
        modelCallId: options.modelCallId,
        sessionRevision: options.sessionRevision,
        middlewareDigest: options.middlewareDigest,
        sourceMessages: cloneTranscriptMessages(options.sourceMessages),
        precedingStages: manifests.map(({ name, version, configurationDigest }) => ({
          name,
          version,
          ...(configurationDigest ? { configurationDigest } : {}),
        })),
        estimate: { ...before },
        estimateHistory,
        estimateEntry: (entry) => this.estimator.estimateEntry(entry),
        compression,
        signal: options.signal,
      });
      if (gateResult.frame === gateInput) {
        throw new InvalidContextPolicyResultError(
          `Context final gate must return a new frame: ${this.finalGate.name}`,
        );
      }
      assertPolicyStageResult(gateResult, this.finalGate.name);
      current = cloneContextHistoryFrame(gateResult.frame);
      estimate = estimateHistory(current);
      decisions.push(...cloneContextDecisions(gateResult.decisions));
      manifests.push({
        name: this.finalGate.name,
        version: this.finalGate.version,
        ...(this.finalGate.configurationDigest
          ? { configurationDigest: this.finalGate.configurationDigest() }
          : {}),
        before,
        after: estimate,
      });

      throwIfAborted(options.signal);
      compression.complete(estimate);
      return {
        envelope: { fixed, history: current },
        decisions,
        stages: manifests,
        estimate,
      };
    } catch (error) {
      compression.fail(error);
      throw error;
    }
  }
}
