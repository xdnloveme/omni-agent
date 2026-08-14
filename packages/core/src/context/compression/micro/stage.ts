import { cloneData } from "../../../dataCopy";
import type { JsonValue } from "../../../data";
import { throwIfAborted } from "../../../execution";
import type { ContextPolicyStagePort, ContextRewriteGuardPort } from "../../contracts/ports";
import type { ContextPolicyStageResult, ContextTokenEstimate } from "../../contracts/types";
import type { ContextTokenEstimatorPort } from "../../contracts/ports";
import { cloneContextFrame } from "../../policy/types";
import { microDecision } from "./decisions";
import type {
  ContextProjectionState,
  ContextProjectionStorePort,
  MicroProjectionStrategyPort,
  MicroStrategyProjectionState,
  PendingContextArtifact,
} from "./contracts";
import { microCompressionThreshold, shouldAdvanceMicroCompression } from "./threshold";
import { digestContextValue } from "../../digest";
import { assertMicroProjectionResult, InvalidMicroProjectionResultError } from "./validator";

export interface StableMicroCompressionDependencies {
  readonly projections: ContextProjectionStorePort;
  readonly strategies: readonly MicroProjectionStrategyPort[];
  readonly estimator: ContextTokenEstimatorPort;
  readonly rewriteGuard: ContextRewriteGuardPort;
}

export class StableMicroCompressionStage implements ContextPolicyStagePort {
  readonly name = "stable_micro_compression";
  readonly version = 1;
  constructor(private readonly dependencies: StableMicroCompressionDependencies) {
    assertStrategies(dependencies.strategies);
  }

  configurationDigest(): string {
    return digestContextValue(
      this.dependencies.strategies.map((strategy) => ({
        key: strategy.key,
        name: strategy.name,
        version: strategy.version,
        configurationDigest: strategy.createState().configurationDigest,
      })),
    );
  }

  async apply(
    frame: Parameters<ContextPolicyStagePort["apply"]>[0],
    options: Parameters<ContextPolicyStagePort["apply"]>[1],
  ): Promise<ContextPolicyStageResult> {
    throwIfAborted(options.signal);
    const loaded = await this.dependencies.projections.load(options.sessionId);
    const expectedRevision = loaded?.revision ?? 0;
    let state = reconcileProjectionState(loaded, options.sessionId, this.dependencies.strategies);
    let current = cloneContextFrame(frame);
    let estimate = this.dependencies.estimator.estimate(current);
    const replayDetails: { [key: string]: JsonValue }[] = [];

    for (const strategy of this.dependencies.strategies) {
      throwIfAborted(options.signal);
      const result = await strategy.replay(current, state.strategies[strategy.key]!, {
        agentId: options.agentId,
        sessionId: options.sessionId,
        modelCallId: options.modelCallId,
        estimate,
        signal: options.signal,
      });
      assertMicroProjectionResult(result, strategy, "replay");
      current = cloneContextFrame(result.frame);
      state = withStrategyState(state, strategy.key, result.state);
      estimate = this.dependencies.estimator.estimate(current);
      if (result.details)
        replayDetails.push({ strategy: strategy.name, ...cloneData(result.details) });
    }

    const beforeAdvance = estimate;
    if (!shouldAdvanceMicroCompression(estimate)) {
      return {
        frame: current,
        decisions: [
          microDecision({
            status: replayDetails.length > 0 ? "replayed" : "skipped",
            reason: "below_threshold",
            before: options.estimate,
            after: estimate,
            revision: expectedRevision,
            details: {
              cacheImpact: replayDetails.length > 0 ? "stable_replay" : "none",
              thresholdTokens: microCompressionThreshold(estimate),
              strategies: cloneData(replayDetails),
            },
          }),
        ],
      };
    }

    const candidates = this.dependencies.strategies.filter((strategy) =>
      strategy.canAdvance(current, state.strategies[strategy.key]!, {
        agentId: options.agentId,
        sessionId: options.sessionId,
        modelCallId: options.modelCallId,
        estimate,
        signal: options.signal,
      }),
    );
    if (candidates.length === 0) {
      return {
        frame: current,
        decisions: [
          microDecision({
            status: replayDetails.length > 0 ? "replayed" : "no_change",
            reason: "no_candidates",
            before: options.estimate,
            after: estimate,
            revision: expectedRevision,
            details: {
              cacheImpact: replayDetails.length > 0 ? "stable_replay" : "none",
              strategies: cloneData(replayDetails),
            },
          }),
        ],
      };
    }

    const guard = await this.dependencies.rewriteGuard.assess({
      agentId: options.agentId,
      sessionId: options.sessionId,
      modelCallId: options.modelCallId,
      estimate,
      signal: options.signal,
    });
    throwIfAborted(options.signal);
    assertRewriteDecision(guard);
    if (guard.action === "defer") {
      return {
        frame: current,
        decisions: [
          microDecision({
            status: "deferred",
            reason: guard.reason,
            before: options.estimate,
            after: estimate,
            revision: expectedRevision,
            details: {
              cacheImpact: replayDetails.length > 0 ? "stable_replay" : "none",
              ...(guard.reconsiderAt === undefined ? {} : { reconsiderAt: guard.reconsiderAt }),
            },
          }),
        ],
      };
    }

    let changed = false;
    const artifacts: PendingContextArtifact[] = [];
    const advanceDetails: { [key: string]: JsonValue }[] = [];
    for (const strategy of this.dependencies.strategies) {
      if (!shouldAdvanceMicroCompression(estimate)) break;
      if (
        !strategy.canAdvance(current, state.strategies[strategy.key]!, {
          agentId: options.agentId,
          sessionId: options.sessionId,
          modelCallId: options.modelCallId,
          estimate,
          signal: options.signal,
        })
      ) {
        continue;
      }
      throwIfAborted(options.signal);
      const previousRecordCount = state.strategies[strategy.key]!.records.length;
      const result = await strategy.advance(current, state.strategies[strategy.key]!, {
        agentId: options.agentId,
        sessionId: options.sessionId,
        modelCallId: options.modelCallId,
        estimate,
        signal: options.signal,
      });
      assertMicroProjectionResult(result, strategy, "advance");
      if (!result.changed) {
        throw new InvalidMicroProjectionResultError(
          strategy.name,
          "canAdvance returned true but advance produced no change",
        );
      }
      options.compression.begin(strategy.compressionKind, {
        inputTokens: estimate.totalInputTokens,
        usableInputBudget: estimate.usableInputBudget,
        thresholdTokens: microCompressionThreshold(estimate),
      });
      current = cloneContextFrame(result.frame);
      state = withStrategyState(state, strategy.key, result.state);
      estimate = this.dependencies.estimator.estimate(current);
      changed ||= result.changed;
      options.compression.record({
        kind: strategy.compressionKind,
        affectedCount:
          result.affectedCount ?? Math.max(0, result.state.records.length - previousRecordCount),
      });
      artifacts.push(...result.artifacts.map((artifact) => ({ ...artifact })));
      advanceDetails.push({
        strategy: strategy.name,
        changed: result.changed,
        ...(result.details ? cloneData(result.details) : {}),
      });
    }

    if (!changed) {
      throw new InvalidMicroProjectionResultError(
        this.name,
        "candidate set changed before any strategy could advance",
      );
    }

    const nextState: ContextProjectionState = {
      ...state,
      revision: expectedRevision + 1,
    };
    await this.dependencies.projections.commit({
      sessionId: options.sessionId,
      expectedRevision,
      nextState,
      artifacts,
    });
    throwIfAborted(options.signal);
    return {
      frame: current,
      decisions: [
        microDecision({
          status: "advanced",
          reason: guard.reason,
          before: beforeAdvance,
          after: estimate,
          revision: nextState.revision,
          details: {
            cacheImpact: "prefix_rewrite",
            artifactIds: artifacts.map((artifact) => artifact.artifactId),
            strategies: cloneData(advanceDetails),
          },
        }),
      ],
    };
  }
}

function reconcileProjectionState(
  loaded: ContextProjectionState | undefined,
  sessionId: string,
  strategies: readonly MicroProjectionStrategyPort[],
): ContextProjectionState {
  const states: Record<string, MicroStrategyProjectionState> = {};
  for (const strategy of strategies) {
    states[strategy.key] = cloneData(loaded?.strategies[strategy.key] ?? strategy.createState());
  }
  return {
    version: 1,
    sessionId,
    revision: loaded?.revision ?? 0,
    strategies: states,
  };
}

function withStrategyState(
  state: ContextProjectionState,
  key: string,
  strategyState: MicroStrategyProjectionState,
): ContextProjectionState {
  return {
    ...state,
    strategies: { ...state.strategies, [key]: cloneData(strategyState) },
  };
}

function assertStrategies(strategies: readonly MicroProjectionStrategyPort[]): void {
  const keys = new Set<string>();
  for (const strategy of strategies) {
    const state = strategy.createState();
    if (
      !/^[a-z][a-z0-9_]*$/.test(strategy.key) ||
      keys.has(strategy.key) ||
      !strategy.name.trim() ||
      !Number.isInteger(strategy.version) ||
      strategy.version < 1 ||
      state.strategyName !== strategy.name ||
      state.strategyVersion !== strategy.version ||
      !state.configurationDigest
    ) {
      throw new Error(`Invalid Stable Micro strategy: ${strategy.name}`);
    }
    keys.add(strategy.key);
  }
}

function assertRewriteDecision(value: unknown): asserts value is {
  readonly action: "allow" | "defer";
  readonly reason: string;
  readonly reconsiderAt?: number;
} {
  if (!value || typeof value !== "object") {
    throw new Error("Context rewrite guard returned no decision");
  }
  const decision = value as { action?: unknown; reason?: unknown; reconsiderAt?: unknown };
  if (
    !["allow", "defer"].includes(String(decision.action)) ||
    typeof decision.reason !== "string" ||
    !decision.reason ||
    (decision.reconsiderAt !== undefined && !Number.isFinite(decision.reconsiderAt))
  ) {
    throw new Error("Context rewrite guard returned an invalid decision");
  }
}
