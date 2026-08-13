import type { DeepReadonly } from "../../data";
import type { ModelToolSpec } from "../../models/runtime";
import type {
  ContextConversationSource,
  ContextDraft,
  ContextMiddlewareOptions,
  ContextModelLimits,
  ContextStrategyOptions,
  ContextStrategyResult,
  PreparedModelContext,
} from "./types";

export interface ContextMiddlewarePort {
  readonly name: string;
  readonly version: number;
  transform(
    draft: DeepReadonly<ContextDraft>,
    options: ContextMiddlewareOptions,
  ): ContextDraft | Promise<ContextDraft>;
}

export interface ContextStrategyPort {
  readonly name: string;
  readonly version: number;
  apply(
    draft: DeepReadonly<ContextDraft>,
    options: ContextStrategyOptions,
  ): Promise<ContextStrategyResult>;
}

export interface ContextPreparationRequest {
  readonly identity: {
    readonly agentId: string;
    readonly sessionId: string;
    readonly sessionRevision: number;
    readonly modelCallId: string;
  };
  readonly source: ContextConversationSource;
  readonly systemPrompt: string;
  readonly tools: readonly ModelToolSpec[];
  readonly model: ContextModelLimits;
  readonly middleware: readonly ContextMiddlewarePort[];
  readonly signal?: AbortSignal;
}

export interface ContextEnginePort {
  prepare(request: ContextPreparationRequest): Promise<PreparedModelContext>;
}

export interface ContextCapability {
  readonly strategy: ContextStrategyPort;
}
