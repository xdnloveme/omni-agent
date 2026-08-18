import type { DeepReadonly, JsonValue } from "../../../data";
import type {
  ContextEntry,
  ContextHistoryFrame,
  ContextTokenEstimate,
} from "../../contracts/types";
import type { ContextCompressionKind } from "../../contracts/progress";
import type { ThinkingHistoryPolicy } from "../../../models/runtime";

export interface MicroProjectionRecord {
  readonly kind: string;
  readonly sourceId: string;
  readonly sourceIndex: number;
  readonly sourceDigest: string;
  readonly projectionDigest: string;
  readonly data?: DeepReadonly<Record<string, JsonValue>>;
}

export interface MicroStrategyProjectionState {
  readonly strategyName: string;
  readonly strategyVersion: number;
  readonly configurationDigest: string;
  readonly records: readonly MicroProjectionRecord[];
}

export interface ContextProjectionState {
  readonly version: 1;
  readonly sessionId: string;
  readonly revision: number;
  readonly strategies: Readonly<Record<string, MicroStrategyProjectionState>>;
}

export interface PendingContextArtifact {
  readonly artifactId: string;
  readonly content: string;
  readonly contentDigest: string;
}

export interface ContextProjectionStorePort {
  load(sessionId: string): Promise<ContextProjectionState | undefined>;
  artifactPath(sessionId: string, artifactId: string): string;
  artifactMatches(sessionId: string, artifactId: string, contentDigest: string): Promise<boolean>;
  commit(input: {
    readonly sessionId: string;
    readonly expectedRevision: number;
    readonly nextState: ContextProjectionState;
    readonly artifacts: readonly PendingContextArtifact[];
  }): Promise<void>;
}

export interface MicroProjectionOptions {
  readonly agentId: string;
  readonly sessionId: string;
  readonly modelCallId: string;
  readonly estimate: ContextTokenEstimate;
  readonly toolCycles: ContextToolCycleView;
  readonly estimateEntry: (entry: DeepReadonly<ContextEntry>) => number;
  readonly signal?: AbortSignal;
}

export type MicroProjectionReplayOptions = Omit<
  MicroProjectionOptions,
  "toolCycles" | "estimateEntry"
>;

export type MicroProjectionLossClass = "discardable" | "recoverable" | "semantic";

export interface MicroProjectionCandidate {
  readonly strategyKey: string;
  readonly sourceId: string;
  readonly sourceIndex: number;
  readonly sourceDigest: string;
  readonly estimatedOriginalTokens: number;
  readonly estimatedProjectedTokens: number;
  readonly estimatedNetSavingsTokens: number;
  readonly reductionRatio: number;
  readonly lossClass: MicroProjectionLossClass;
}

export interface MicroProjectionAssessment {
  readonly strategyName: string;
  readonly strategyVersion: number;
  readonly configurationDigest: string;
  readonly candidates: readonly MicroProjectionCandidate[];
  readonly reason: string;
  readonly details?: DeepReadonly<Record<string, JsonValue>>;
}

export interface ContextToolCycle {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly span: {
    readonly startSourceIndex: number;
    readonly endSourceIndex: number;
  };
  readonly call?: {
    readonly sourceIndex: number;
    readonly contentIndex: number;
    readonly sourceDigest: string;
  };
  readonly result?: {
    readonly sourceIndex: number;
    readonly sourceDigest: string;
    readonly isError: boolean;
  };
  readonly status: "completed" | "pending" | "orphan_result" | "duplicate" | "name_mismatch";
  readonly consumed: boolean;
}

export interface ContextToolCycleView {
  readonly cycles: readonly ContextToolCycle[];
  findByResultSourceIndex(sourceIndex: number): ContextToolCycle | undefined;
}

export interface MicroProjectionResult {
  readonly frame: ContextHistoryFrame;
  readonly state: MicroStrategyProjectionState;
  readonly changed: boolean;
  readonly affectedCount?: number;
  readonly artifacts: readonly PendingContextArtifact[];
  readonly details?: DeepReadonly<Record<string, JsonValue>>;
}

export interface MicroProjectionStrategyPort {
  readonly key: string;
  readonly name: string;
  readonly version: number;
  readonly compressionKind: ContextCompressionKind;
  createState(): MicroStrategyProjectionState;
  /** Finds deterministic candidates without performing I/O or mutating the frame. */
  assess(
    frame: DeepReadonly<ContextHistoryFrame>,
    state: DeepReadonly<MicroStrategyProjectionState>,
    options: DeepReadonly<MicroProjectionOptions>,
  ): MicroProjectionAssessment;
  /** Reapplies committed projections without creating or persisting new state. */
  replay(
    frame: DeepReadonly<ContextHistoryFrame>,
    state: DeepReadonly<MicroStrategyProjectionState>,
    options: DeepReadonly<MicroProjectionReplayOptions>,
  ): Promise<MicroProjectionResult>;
  /** Applies exactly the globally selected candidates and returns pending state changes. */
  advance(
    frame: DeepReadonly<ContextHistoryFrame>,
    state: DeepReadonly<MicroStrategyProjectionState>,
    selected: readonly DeepReadonly<MicroProjectionCandidate>[],
    options: DeepReadonly<MicroProjectionOptions>,
  ): Promise<MicroProjectionResult>;
}

export type { ThinkingHistoryPolicy };
