import { cloneData } from "../../../dataCopy";
import type { JsonValue } from "../../../data";
import { throwIfAborted } from "../../../execution";
import type { ContextPolicyStagePort, ContextRewriteGuardPort } from "../../contracts/ports";
import type { ContextPolicyStageResult, ContextTokenEstimate } from "../../contracts/types";
import { digestContextValue } from "../../digest";
import { cloneContextHistoryFrame } from "../../policy/types";
import { createContextToolCycleView } from "../toolCycle";
import { microDecision } from "./decisions";
import type {
  ContextProjectionState,
  ContextProjectionStorePort,
  ContextToolCycleView,
  MicroProjectionAssessment,
  MicroProjectionCandidate,
  MicroProjectionOptions,
  MicroProjectionReplayOptions,
  MicroProjectionStrategyPort,
  MicroStrategyProjectionState,
  PendingContextArtifact,
} from "./contracts";
import {
  MICRO_LOSS_CLASS_ORDER,
  MINIMUM_MICRO_REDUCTION_RATIO,
  selectMicroProjectionCandidates,
} from "./selector";
import {
  MICRO_HEADROOM_MINIMUM_TOKENS,
  MICRO_HEADROOM_RATIO,
  MICRO_THRESHOLD_POLICY_VERSION,
  microCompressionHeadroom,
  microCompressionTarget,
  microCompressionThreshold,
  shouldAdvanceMicroCompression,
} from "./threshold";
import {
  assertMicroProjectionAssessment,
  assertMicroProjectionResult,
  InvalidMicroProjectionResultError,
} from "./validator";

export interface StableMicroCompressionDependencies {
  readonly projections: ContextProjectionStorePort;
  readonly strategies: readonly MicroProjectionStrategyPort[];
  readonly rewriteGuard: ContextRewriteGuardPort;
}

export class StableMicroCompressionStage implements ContextPolicyStagePort {
  readonly name = "stable_micro_compression";
  readonly version = 2;

  constructor(private readonly dependencies: StableMicroCompressionDependencies) {
    assertStrategies(dependencies.strategies);
  }

  configurationDigest(): string {
    return digestContextValue({
      thresholdPolicyVersion: MICRO_THRESHOLD_POLICY_VERSION,
      minimumHeadroomTokens: MICRO_HEADROOM_MINIMUM_TOKENS,
      headroomRatio: MICRO_HEADROOM_RATIO,
      minimumCandidateReductionRatio: MINIMUM_MICRO_REDUCTION_RATIO,
      lossClassOrder: MICRO_LOSS_CLASS_ORDER,
      strategies: this.dependencies.strategies.map((strategy) => ({
        key: strategy.key,
        name: strategy.name,
        version: strategy.version,
        configurationDigest: strategy.createState().configurationDigest,
      })),
    });
  }

  async apply(
    frame: Parameters<ContextPolicyStagePort["apply"]>[0],
    options: Parameters<ContextPolicyStagePort["apply"]>[1],
  ): Promise<ContextPolicyStageResult> {
    throwIfAborted(options.signal);
    const loaded = await this.dependencies.projections.load(options.sessionId);
    const expectedRevision = loaded?.revision ?? 0;
    let state = reconcileProjectionState(loaded, options.sessionId, this.dependencies.strategies);
    let current = cloneContextHistoryFrame(frame);
    let estimate = options.estimateHistory(current);
    const replayDetails: Record<string, JsonValue>[] = [];
    let replayedProjectionCount = 0;

    for (const strategy of this.dependencies.strategies) {
      throwIfAborted(options.signal);
      const beforeReplay = cloneContextHistoryFrame(current);
      const result = await strategy.replay(
        cloneContextHistoryFrame(beforeReplay),
        cloneData(state.strategies[strategy.key]!),
        replayOptions(options, estimate),
      );
      assertMicroProjectionResult(result, strategy, "replay", { before: beforeReplay });
      current = cloneContextHistoryFrame(result.frame);
      state = withStrategyState(state, strategy.key, result.state);
      estimate = options.estimateHistory(current);
      if (result.details) {
        replayDetails.push({ strategy: strategy.name, ...cloneData(result.details) });
        replayedProjectionCount += numericDetail(result.details, "replayedCount");
      }
    }

    const beforeAdvance = estimate;
    const thresholdTokens = microCompressionThreshold(estimate);
    const headroomTokens = microCompressionHeadroom(estimate);
    const targetTokens = microCompressionTarget(estimate);
    if (!shouldAdvanceMicroCompression(estimate)) {
      return decisionResult(current, {
        status: replayedProjectionCount > 0 ? "replayed" : "skipped",
        reason: "below_threshold",
        before: options.estimate,
        after: estimate,
        revision: expectedRevision,
        details: {
          cacheImpact: replayedProjectionCount > 0 ? "stable_replay" : "none",
          thresholdTokens,
          headroomTokens,
          targetTokens,
          strategies: cloneData(replayDetails),
        },
      });
    }

    const toolCycles = createContextToolCycleView(current.entries);
    const assessments = this.dependencies.strategies.map((strategy) => {
      throwIfAborted(options.signal);
      const assessment = strategy.assess(
        cloneContextHistoryFrame(current),
        cloneData(state.strategies[strategy.key]!),
        advanceOptions(options, estimate, toolCycles),
      );
      assertMicroProjectionAssessment(assessment, strategy, current);
      return assessment;
    });
    const requiredSavingsTokens = estimate.totalInputTokens - targetTokens;
    const selection = selectMicroProjectionCandidates(assessments, requiredSavingsTokens);
    const assessmentDetails = assessments.map(toAssessmentDetails);

    if (!selection.sufficient) {
      return decisionResult(current, {
        status: replayedProjectionCount > 0 ? "replayed" : "no_change",
        reason: assessments.some((assessment) => assessment.candidates.length > 0)
          ? "insufficient_candidates"
          : "no_candidates",
        before: options.estimate,
        after: estimate,
        revision: expectedRevision,
        details: {
          cacheImpact: replayedProjectionCount > 0 ? "stable_replay" : "none",
          thresholdTokens,
          headroomTokens,
          targetTokens,
          requiredSavingsTokens,
          availableSavingsTokens: selection.estimatedSavingsTokens,
          toolCycles: summarizeToolCycles(toolCycles),
          strategies: cloneData(assessmentDetails),
        },
      });
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
    const guardReason = guard.reason;
    if (guard.action === "defer") {
      return decisionResult(current, {
        status: "deferred",
        reason: guardReason,
        before: options.estimate,
        after: estimate,
        revision: expectedRevision,
        details: {
          cacheImpact: replayedProjectionCount > 0 ? "stable_replay" : "none",
          thresholdTokens,
          headroomTokens,
          targetTokens,
          requiredSavingsTokens,
          selectedCount: selection.selected.length,
          guardAction: "defer",
          ...(guard.reconsiderAt === undefined ? {} : { reconsiderAt: guard.reconsiderAt }),
        },
      });
    }

    const selectedGroups = groupSelectedCandidates(
      selection.selected,
      this.dependencies.strategies,
    );
    const firstStrategy = selectedGroups[0]?.strategy;
    if (!firstStrategy) {
      throw new InvalidMicroProjectionResultError(this.name, "selection contained no strategy");
    }
    options.compression.begin(firstStrategy.compressionKind, {
      inputTokens: estimate.totalInputTokens,
      usableInputBudget: estimate.usableInputBudget,
      thresholdTokens,
    });

    const artifacts: PendingContextArtifact[] = [];
    const advanceDetails: Record<string, JsonValue>[] = [];
    for (const group of selectedGroups) {
      throwIfAborted(options.signal);
      const beforeFrame = cloneContextHistoryFrame(current);
      const beforeState = cloneData(state.strategies[group.strategy.key]!);
      const beforeEstimate = estimate;
      const selectedInput = cloneData(group.candidates);
      const result = await group.strategy.advance(
        cloneContextHistoryFrame(beforeFrame),
        cloneData(beforeState),
        selectedInput,
        advanceOptions(options, estimate, toolCycles),
      );
      assertMicroProjectionResult(result, group.strategy, "advance", {
        before: beforeFrame,
        beforeState,
        selected: group.candidates,
        estimateEntry: (entry) => options.estimateEntry(entry),
      });
      current = cloneContextHistoryFrame(result.frame);
      state = withStrategyState(state, group.strategy.key, result.state);
      estimate = options.estimateHistory(current);
      options.compression.record({
        kind: group.strategy.compressionKind,
        affectedCount: result.affectedCount ?? group.candidates.length,
      });
      artifacts.push(...result.artifacts.map((artifact) => ({ ...artifact })));
      advanceDetails.push({
        strategy: group.strategy.name,
        selectedCount: group.candidates.length,
        estimatedSavingsTokens: group.candidates.reduce(
          (total, candidate) => total + candidate.estimatedNetSavingsTokens,
          0,
        ),
        actualSavingsTokens: beforeEstimate.totalInputTokens - estimate.totalInputTokens,
        ...(result.details ? cloneData(result.details) : {}),
      });
    }

    if (estimate.totalInputTokens >= beforeAdvance.totalInputTokens) {
      throw new InvalidMicroProjectionResultError(
        this.name,
        "selected projections did not reduce the context",
      );
    }
    if (estimate.totalInputTokens > targetTokens) {
      throw new InvalidMicroProjectionResultError(
        this.name,
        "selected projections did not reach the Micro target",
      );
    }

    const nextState: ContextProjectionState = {
      ...state,
      revision: expectedRevision + 1,
    };
    throwIfAborted(options.signal);
    await this.dependencies.projections.commit({
      sessionId: options.sessionId,
      expectedRevision,
      nextState,
      artifacts,
    });

    return decisionResult(current, {
      status: "advanced",
      reason: guardReason,
      before: beforeAdvance,
      after: estimate,
      revision: nextState.revision,
      details: {
        cacheImpact: "prefix_rewrite",
        thresholdTokens,
        headroomTokens,
        targetTokens,
        requiredSavingsTokens,
        selectedCount: selection.selected.length,
        guardAction: "allow",
        estimatedSavingsTokens: selection.estimatedSavingsTokens,
        actualSavingsTokens: beforeAdvance.totalInputTokens - estimate.totalInputTokens,
        reductionRatio:
          (beforeAdvance.totalInputTokens - estimate.totalInputTokens) /
          beforeAdvance.totalInputTokens,
        artifactIds: artifacts.map((artifact) => artifact.artifactId),
        toolCycles: summarizeToolCycles(toolCycles),
        strategies: cloneData(advanceDetails),
      },
    });
  }
}

function replayOptions(
  options: Parameters<ContextPolicyStagePort["apply"]>[1],
  estimate: ContextTokenEstimate,
): MicroProjectionReplayOptions {
  return {
    agentId: options.agentId,
    sessionId: options.sessionId,
    modelCallId: options.modelCallId,
    estimate: cloneData(estimate),
    signal: options.signal,
  };
}

function advanceOptions(
  options: Parameters<ContextPolicyStagePort["apply"]>[1],
  estimate: ContextTokenEstimate,
  toolCycles: ContextToolCycleView,
): MicroProjectionOptions {
  return {
    ...replayOptions(options, estimate),
    toolCycles,
    estimateEntry: (entry) => options.estimateEntry(entry),
  };
}

function groupSelectedCandidates(
  selected: readonly MicroProjectionCandidate[],
  strategies: readonly MicroProjectionStrategyPort[],
): readonly {
  readonly strategy: MicroProjectionStrategyPort;
  readonly candidates: readonly MicroProjectionCandidate[];
}[] {
  const byKey = new Map(strategies.map((strategy) => [strategy.key, strategy]));
  const groups = new Map<
    string,
    { strategy: MicroProjectionStrategyPort; candidates: MicroProjectionCandidate[] }
  >();
  for (const candidate of selected) {
    const strategy = byKey.get(candidate.strategyKey);
    if (!strategy) {
      throw new InvalidMicroProjectionResultError(
        candidate.strategyKey,
        "selected candidate references an unknown strategy",
      );
    }
    const existing = groups.get(strategy.key);
    if (existing) existing.candidates.push({ ...candidate });
    else groups.set(strategy.key, { strategy, candidates: [{ ...candidate }] });
  }
  return [...groups.values()];
}

function toAssessmentDetails(assessment: MicroProjectionAssessment): Record<string, JsonValue> {
  return {
    strategy: assessment.strategyName,
    reason: assessment.reason,
    candidateCount: assessment.candidates.length,
    estimatedSavingsTokens: assessment.candidates.reduce(
      (total, candidate) => total + candidate.estimatedNetSavingsTokens,
      0,
    ),
    ...(assessment.details ? cloneData(assessment.details) : {}),
  };
}

function summarizeToolCycles(cycles: ContextToolCycleView): Record<string, JsonValue> {
  const counts: Record<string, number> = {
    completed: 0,
    pending: 0,
    orphan_result: 0,
    duplicate: 0,
    name_mismatch: 0,
    consumed: 0,
    unconsumed: 0,
    errorResults: 0,
  };
  for (const cycle of cycles.cycles) {
    counts[cycle.status] = (counts[cycle.status] ?? 0) + 1;
    const consumption = cycle.consumed ? "consumed" : "unconsumed";
    counts[consumption] = (counts[consumption] ?? 0) + 1;
    if (cycle.result?.isError) counts.errorResults = (counts.errorResults ?? 0) + 1;
  }
  return counts;
}

function numericDetail(details: Readonly<Record<string, JsonValue>>, key: string): number {
  const value = details[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function decisionResult(
  frame: Parameters<ContextPolicyStagePort["apply"]>[0],
  input: Parameters<typeof microDecision>[0],
): ContextPolicyStageResult {
  return { frame: cloneContextHistoryFrame(frame), decisions: [microDecision(input)] };
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
  const names = new Set<string>();
  for (const strategy of strategies) {
    const state = strategy.createState();
    if (
      !/^[a-z][a-z0-9_]*$/.test(strategy.key) ||
      keys.has(strategy.key) ||
      !strategy.name.trim() ||
      names.has(strategy.name) ||
      !Number.isInteger(strategy.version) ||
      strategy.version < 1 ||
      state.strategyName !== strategy.name ||
      state.strategyVersion !== strategy.version ||
      !state.configurationDigest ||
      typeof strategy.assess !== "function" ||
      typeof strategy.replay !== "function" ||
      typeof strategy.advance !== "function"
    ) {
      throw new Error(`Invalid Stable Micro strategy: ${strategy.name}`);
    }
    keys.add(strategy.key);
    names.add(strategy.name);
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
