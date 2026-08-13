import { cloneContextFrame } from "../../policy/types";
import type { ContextFrame } from "../../contracts/types";
import type {
  MicroProjectionRecord,
  MicroProjectionResult,
  MicroProjectionStrategyPort,
  MicroStrategyProjectionState,
} from "./contracts";

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
  frame: Readonly<ContextFrame>,
  state: MicroStrategyProjectionState,
): MicroProjectionResult {
  return { frame: cloneContextFrame(frame), state, changed: false, artifacts: [] };
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
