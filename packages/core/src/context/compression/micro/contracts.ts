import type { DeepReadonly, JsonValue } from "../../../data";
import type { ContextHistoryFrame, ContextTokenEstimate } from "../../contracts/types";
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
  readonly signal?: AbortSignal;
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
  canAdvance(
    frame: DeepReadonly<ContextHistoryFrame>,
    state: DeepReadonly<MicroStrategyProjectionState>,
    options: DeepReadonly<MicroProjectionOptions>,
  ): boolean;
  replay(
    frame: DeepReadonly<ContextHistoryFrame>,
    state: DeepReadonly<MicroStrategyProjectionState>,
    options: DeepReadonly<MicroProjectionOptions>,
  ): Promise<MicroProjectionResult>;
  advance(
    frame: DeepReadonly<ContextHistoryFrame>,
    state: DeepReadonly<MicroStrategyProjectionState>,
    options: DeepReadonly<MicroProjectionOptions>,
  ): Promise<MicroProjectionResult>;
}

export type { ThinkingHistoryPolicy };
