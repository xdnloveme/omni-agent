import { assertPolicyStageResult } from "../../policy/validator";
import { isJsonValue } from "../../../data";
import type { ContextEntry, ContextHistoryFrame } from "../../contracts/types";
import { digestContextValue } from "../../digest";
import type {
  MicroProjectionAssessment,
  MicroProjectionCandidate,
  MicroProjectionResult,
  MicroProjectionStrategyPort,
  MicroStrategyProjectionState,
} from "./contracts";
import { digestEntrySource, MINIMUM_MICRO_REDUCTION_RATIO } from "./selector";
import { projectionRecordKey, projectionSourceKey, validStrategyRecords } from "./strategyState";

export class InvalidMicroProjectionResultError extends Error {
  constructor(strategy: string, message: string) {
    super(`Invalid Micro Projection result from ${strategy}: ${message}`);
    this.name = "InvalidMicroProjectionResultError";
  }
}

export function assertMicroProjectionResult(
  result: MicroProjectionResult,
  strategy: MicroProjectionStrategyPort,
  phase: "replay" | "advance",
  validation?: {
    readonly before: ContextHistoryFrame;
    readonly beforeState?: MicroStrategyProjectionState;
    readonly selected?: readonly MicroProjectionCandidate[];
    readonly estimateEntry?: (entry: ContextEntry) => number;
  },
): void {
  assertPolicyStageResult({ frame: result?.frame, decisions: [] }, strategy.name);
  if (!result.state || typeof result.state !== "object") invalid(strategy, "state is required");
  const expected = strategy.createState();
  if (
    result.state.strategyName !== strategy.name ||
    result.state.strategyVersion !== strategy.version ||
    result.state.configurationDigest !== expected.configurationDigest ||
    !Array.isArray(result.state.records)
  ) {
    invalid(strategy, "state identity or configuration is inconsistent");
  }
  if (typeof result.changed !== "boolean" || !Array.isArray(result.artifacts)) {
    invalid(strategy, "changed and artifacts are required");
  }
  if (
    (result.affectedCount !== undefined &&
      (!Number.isInteger(result.affectedCount) || result.affectedCount < 0)) ||
    (result.details !== undefined && !isJsonValue(result.details))
  ) {
    invalid(strategy, "result metadata is invalid");
  }
  if (phase === "replay" && (result.changed || result.artifacts.length > 0)) {
    invalid(strategy, "replay must be read-only");
  }
  if (phase === "advance" && !result.changed) {
    invalid(strategy, "advance must report a changed result");
  }
  const recordKeys = new Set<string>();
  const recordSources = new Set<string>();
  for (const record of result.state.records) {
    const recordKey = record ? projectionRecordKey(record) : "";
    const recordSource = record ? projectionSourceKey(record) : "";
    if (
      !record ||
      record.kind !== strategy.key ||
      !record.sourceId ||
      !Number.isInteger(record.sourceIndex) ||
      record.sourceIndex < 0 ||
      !record.sourceDigest ||
      !record.projectionDigest ||
      (record.data !== undefined && !isJsonValue(record.data)) ||
      recordKeys.has(recordKey) ||
      recordSources.has(recordSource)
    ) {
      invalid(strategy, "projection record is invalid");
    }
    recordKeys.add(recordKey);
    recordSources.add(recordSource);
  }
  for (const artifact of result.artifacts) {
    if (!artifact?.artifactId || typeof artifact.content !== "string" || !artifact.contentDigest) {
      invalid(strategy, "pending artifact is invalid");
    }
  }
  if (!validation) invalid(strategy, `${phase} validation context is required`);
  if (phase === "replay") {
    assertReplayedChanges(result, strategy, validation.before);
  } else {
    if (!validation.beforeState || !validation.selected || !validation.estimateEntry) {
      invalid(strategy, "advance validation context is incomplete");
    }
    assertSelectedChanges(result, strategy, {
      before: validation.before,
      beforeState: validation.beforeState,
      selected: validation.selected,
      estimateEntry: validation.estimateEntry,
    });
  }
}

export function assertMicroProjectionAssessment(
  assessment: MicroProjectionAssessment,
  strategy: MicroProjectionStrategyPort,
  frame: ContextHistoryFrame,
): void {
  const expected = strategy.createState();
  if (
    !assessment ||
    assessment.strategyName !== strategy.name ||
    assessment.strategyVersion !== strategy.version ||
    assessment.configurationDigest !== expected.configurationDigest ||
    !Array.isArray(assessment.candidates) ||
    typeof assessment.reason !== "string" ||
    !assessment.reason ||
    (assessment.details !== undefined && !isJsonValue(assessment.details))
  ) {
    invalid(strategy, "assessment identity or structure is invalid");
  }
  const sourceIndexes = new Set<number>();
  const sourceIds = new Set<string>();
  const identities = new Set<string>();
  for (const candidate of assessment.candidates) {
    const entry = frame.entries.find(
      (item) => item.kind !== "checkpoint" && item.sourceIndex === candidate.sourceIndex,
    );
    const identity = projectionRecordKey(candidate);
    if (
      candidate.strategyKey !== strategy.key ||
      !candidate.sourceId ||
      !Number.isInteger(candidate.sourceIndex) ||
      candidate.sourceIndex < 0 ||
      !candidate.sourceDigest ||
      !Number.isFinite(candidate.estimatedOriginalTokens) ||
      !Number.isFinite(candidate.estimatedProjectedTokens) ||
      !Number.isFinite(candidate.estimatedNetSavingsTokens) ||
      !Number.isFinite(candidate.reductionRatio) ||
      candidate.estimatedNetSavingsTokens <= 0 ||
      candidate.estimatedOriginalTokens < 0 ||
      candidate.estimatedProjectedTokens < 0 ||
      candidate.estimatedOriginalTokens - candidate.estimatedProjectedTokens !==
        candidate.estimatedNetSavingsTokens ||
      Math.abs(
        candidate.estimatedNetSavingsTokens / candidate.estimatedOriginalTokens -
          candidate.reductionRatio,
      ) > Number.EPSILON ||
      candidate.reductionRatio < MINIMUM_MICRO_REDUCTION_RATIO ||
      !["discardable", "recoverable", "semantic"].includes(candidate.lossClass) ||
      identities.has(identity) ||
      sourceIds.has(candidate.sourceId) ||
      sourceIndexes.has(candidate.sourceIndex) ||
      !entry ||
      digestEntrySource(entry) !== candidate.sourceDigest
    ) {
      invalid(strategy, "assessment contains an invalid or conflicting candidate");
    }
    identities.add(identity);
    sourceIds.add(candidate.sourceId);
    sourceIndexes.add(candidate.sourceIndex);
  }
}

function assertSelectedChanges(
  result: MicroProjectionResult,
  strategy: MicroProjectionStrategyPort,
  input: {
    readonly before: ContextHistoryFrame;
    readonly beforeState: MicroStrategyProjectionState;
    readonly selected: readonly MicroProjectionCandidate[];
    readonly estimateEntry: (entry: ContextEntry) => number;
  },
): void {
  if (input.before.entries.length !== result.frame.entries.length) {
    invalid(strategy, "advance must preserve the entry count");
  }
  const selectedBySourceIndex = new Map(
    input.selected.map((candidate) => [candidate.sourceIndex, candidate]),
  );
  const changed = new Set<number>();
  for (let index = 0; index < input.before.entries.length; index++) {
    const before = input.before.entries[index]!;
    const after = result.frame.entries[index]!;
    if (before.kind === "checkpoint" || after.kind === "checkpoint") {
      if (digestContextValue(before) !== digestContextValue(after)) {
        invalid(strategy, "advance must not modify checkpoint entries");
      }
      continue;
    }
    if (before.sourceIndex !== after.sourceIndex) {
      invalid(strategy, "advance must preserve entry ordering and source indexes");
    }
    if (digestContextValue(before) === digestContextValue(after)) continue;
    const candidate = selectedBySourceIndex.get(before.sourceIndex);
    if (!candidate) invalid(strategy, "advance modified an unselected source entry");
    const originalTokens = input.estimateEntry(before);
    const projectedTokens = input.estimateEntry(after);
    if (
      originalTokens !== candidate.estimatedOriginalTokens ||
      projectedTokens !== candidate.estimatedProjectedTokens ||
      originalTokens - projectedTokens !== candidate.estimatedNetSavingsTokens
    ) {
      invalid(strategy, "advance output does not match the assessed token savings");
    }
    changed.add(before.sourceIndex);
  }
  if (
    changed.size !== input.selected.length ||
    input.selected.some((candidate) => !changed.has(candidate.sourceIndex))
  ) {
    invalid(strategy, "advance did not project every selected candidate exactly once");
  }

  const existing = new Set(
    validStrategyRecords(input.beforeState, strategy).map(projectionRecordKey),
  );
  const resultRecordKeys = new Set(result.state.records.map(projectionRecordKey));
  if ([...existing].some((key) => !resultRecordKeys.has(key))) {
    invalid(strategy, "advance removed an existing projection record");
  }
  const selectedRecords = new Map(
    input.selected.map((candidate) => [projectionRecordKey(candidate), candidate]),
  );
  for (const record of result.state.records) {
    const key = projectionRecordKey(record);
    if (existing.has(key)) continue;
    if (!selectedRecords.has(projectionRecordKey(record))) {
      invalid(strategy, "advance added a projection record for an unselected source");
    }
  }
  for (const candidate of input.selected) {
    if (
      !result.state.records.some(
        (record) => projectionRecordKey(record) === projectionRecordKey(candidate),
      )
    ) {
      invalid(strategy, "advance did not add a projection record for a selected source");
    }
  }

  const artifactIds = result.artifacts.map((artifact) => artifact.artifactId);
  if (new Set(artifactIds).size !== artifactIds.length) {
    invalid(strategy, "advance returned duplicate pending artifacts");
  }
  const pendingArtifacts = new Set(artifactIds);
  const selectedArtifactIds = new Set(
    result.state.records.flatMap((record) => {
      if (!selectedRecords.has(projectionRecordKey(record))) return [];
      const artifactId = record.data?.artifactId;
      return typeof artifactId === "string" ? [artifactId] : [];
    }),
  );
  if (
    [...selectedArtifactIds].some((artifactId) => !pendingArtifacts.has(artifactId)) ||
    artifactIds.some((artifactId) => !selectedArtifactIds.has(artifactId))
  ) {
    invalid(strategy, "advance returned an artifact without a selected projection record");
  }
}

function assertReplayedChanges(
  result: MicroProjectionResult,
  strategy: MicroProjectionStrategyPort,
  before: ContextHistoryFrame,
): void {
  if (before.entries.length !== result.frame.entries.length) {
    invalid(strategy, "replay must preserve the entry count");
  }
  const recordsBySource = new Map(
    result.state.records.map((record) => [record.sourceIndex, record]),
  );
  const replayedSources = new Set<number>();
  for (let index = 0; index < before.entries.length; index++) {
    const source = before.entries[index]!;
    const projected = result.frame.entries[index]!;
    if (source.kind === "checkpoint" || projected.kind === "checkpoint") {
      if (digestContextValue(source) !== digestContextValue(projected)) {
        invalid(strategy, "replay must not modify checkpoint entries");
      }
      continue;
    }
    if (source.sourceIndex !== projected.sourceIndex) {
      invalid(strategy, "replay must preserve entry ordering and source indexes");
    }
    if (digestContextValue(source) === digestContextValue(projected)) continue;
    const record = recordsBySource.get(source.sourceIndex);
    if (
      !record ||
      digestEntrySource(source) !== record.sourceDigest ||
      digestContextValue(projected) !== record.projectionDigest
    ) {
      invalid(strategy, "replay modified an entry without a matching projection record");
    }
    replayedSources.add(source.sourceIndex);
  }
  if (
    replayedSources.size !== result.state.records.length ||
    result.state.records.some((record) => !replayedSources.has(record.sourceIndex))
  ) {
    invalid(strategy, "replay retained a projection record that was not applied");
  }
}

function invalid(strategy: MicroProjectionStrategyPort, message: string): never {
  throw new InvalidMicroProjectionResultError(strategy.name, message);
}
