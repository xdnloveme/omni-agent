import { throwIfAborted } from "../../execution";
import { cloneTranscriptMessages } from "../../messages";
import type {
  ContextFinalGatePort,
  ContextPolicyPort,
  ContextPolicyStagePort,
  ContextTokenEstimatorPort,
} from "../contracts/ports";
import type { ContextDecision, ContextFrame, ContextPolicyResult } from "../contracts/types";
import { cloneContextDecisions, cloneContextFrame } from "./types";
import {
  assertPolicyComponent,
  assertPolicyStageResult,
  InvalidContextPolicyResultError,
} from "./validator";

export { InvalidContextPolicyResultError, assertContextPolicyResult } from "./validator";

export class ContextPolicyPipeline implements ContextPolicyPort {
  constructor(
    private readonly stages: readonly ContextPolicyStagePort[],
    private readonly finalGate: ContextFinalGatePort,
    private readonly estimator: ContextTokenEstimatorPort,
  ) {}

  async resolve(
    frame: ContextFrame,
    options: Parameters<ContextPolicyPort["resolve"]>[1],
  ): Promise<ContextPolicyResult> {
    let current = cloneContextFrame(frame);
    let estimate = this.estimator.estimate(current);
    const decisions: ContextDecision[] = [];
    const manifests: ContextPolicyResult["stages"][number][] = [];

    for (const stage of this.stages) {
      throwIfAborted(options.signal);
      assertPolicyComponent(stage);
      const before = estimate;
      const input = cloneContextFrame(current);
      const result = await stage.apply(input, {
        agentId: options.agentId,
        sessionId: options.sessionId,
        modelCallId: options.modelCallId,
        estimate: { ...before },
        signal: options.signal,
      });
      if (result.frame === input) {
        throw new InvalidContextPolicyResultError(
          `Context policy stage must return a new frame: ${stage.name}`,
        );
      }
      assertPolicyStageResult(result, stage.name);
      current = cloneContextFrame(result.frame);
      estimate = this.estimator.estimate(current);
      decisions.push(...cloneContextDecisions(result.decisions));
      manifests.push({
        name: stage.name,
        version: stage.version,
        ...(stage.configurationDigest ? { configurationDigest: stage.configurationDigest() } : {}),
        before,
        after: estimate,
      });
    }

    throwIfAborted(options.signal);
    assertPolicyComponent(this.finalGate);
    const before = estimate;
    const gateInput = cloneContextFrame(current);
    const gateResult = await this.finalGate.apply(gateInput, {
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
      signal: options.signal,
    });
    if (gateResult.frame === gateInput) {
      throw new InvalidContextPolicyResultError(
        `Context final gate must return a new frame: ${this.finalGate.name}`,
      );
    }
    assertPolicyStageResult(gateResult, this.finalGate.name);
    current = cloneContextFrame(gateResult.frame);
    estimate = this.estimator.estimate(current);
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
    return { frame: current, decisions, stages: manifests, estimate };
  }
}
