import { cloneContextHistoryFrame } from "../../policy/types";
import type { ContextHistoryFrame } from "../../contracts/types";
import type {
  MicroProjectionAssessment,
  MicroProjectionCandidate,
  MicroProjectionRecord,
  MicroProjectionResult,
  MicroProjectionStrategyPort,
  MicroStrategyProjectionState,
} from "./contracts";
import type { JsonValue } from "../../../data";

export function createStrategyState(
  strategy: Pick<MicroProjectionStrategyPort, "name" | "version" | "key">,
  configurationDigest: string,
  records: readonly MicroProjectionRecord[] = [],
): MicroStrategyProjectionState {
  return {
    strategyName: strategy.name,
    strategyVersion: strategy.version,
    configurationDigest,
    records: records.filter((record) => record.kind === strategy.key),
  };
}

export function validStrategyRecords(
  state: Readonly<MicroStrategyProjectionState>,
  strategy: MicroProjectionStrategyPort,
): readonly MicroProjectionRecord[] {
  const current = strategy.createState();
  return state.strategyName === strategy.name &&
    state.strategyVersion === strategy.version &&
    state.configurationDigest === current.configurationDigest
    ? state.records.filter((record) => record.kind === strategy.key)
    : [];
}

export function unchangedProjection(
  frame: Readonly<ContextHistoryFrame>,
  state: MicroStrategyProjectionState,
): MicroProjectionResult {
  return { frame: cloneContextHistoryFrame(frame), state, changed: false, artifacts: [] };
}

export function indexProjectionRecords(
  records: readonly MicroProjectionRecord[],
): ReadonlyMap<string, MicroProjectionRecord> {
  return new Map(records.map((record) => [projectionRecordKey(record), record]));
}

export function projectionRecordKey(input: {
  readonly sourceId: string;
  readonly sourceIndex: number;
  readonly sourceDigest: string;
}): string {
  return `${input.sourceId}\u0000${input.sourceIndex}\u0000${input.sourceDigest}`;
}

export function projectionSourceKey(input: {
  readonly sourceId: string;
  readonly sourceIndex: number;
}): string {
  return `${input.sourceId}\u0000${input.sourceIndex}`;
}

export function toolResultProjectionSourceId(toolCallId: string): string {
  return `toolResult:${toolCallId}`;
}

export function createMicroProjectionAssessment(
  strategy: MicroProjectionStrategyPort,
  candidates: readonly MicroProjectionCandidate[],
  reason: string,
  details?: Readonly<Record<string, JsonValue>>,
): MicroProjectionAssessment {
  return {
    strategyName: strategy.name,
    strategyVersion: strategy.version,
    configurationDigest: strategy.createState().configurationDigest,
    candidates,
    reason,
    ...(details ? { details } : {}),
  };
}

export function projectionReplayDetails(
  records: readonly MicroProjectionRecord[],
  retained: readonly MicroProjectionRecord[],
  replayedCount: number,
): { readonly replayedCount: number; readonly unavailableCount: number } | undefined {
  const unavailableCount = records.length - retained.length;
  // An unavailable projection is deliberately omitted so the original entry
  // remains visible instead of producing a stale model reference.
  return replayedCount > 0 || unavailableCount > 0
    ? { replayedCount, unavailableCount }
    : undefined;
}
