import type { DeepReadonly, JsonValue } from "../data";
import type { AssistantTranscriptMessage, ModelContextMessage } from "../messages";
import type { ModelCacheIntent, ModelCacheReport } from "./cache";
import type { ModelCallIdentity } from "./call";

/** Provider-side generation intent; never replaces local tool validation. */
export type ToolInputConstraint = "off" | "prefer" | "require";
export interface ToolConstraintCapability {
  readonly state: "supported" | "unsupported" | "unknown";
  readonly source: "model" | "connection" | "catalog" | "unknown";
}
export interface ToolConstraintDecision {
  readonly toolName: string;
  readonly intent: ToolInputConstraint | "unspecified";
  readonly capability: ToolConstraintCapability;
  readonly schema: "compatible" | "incompatible" | "unknown" | "not_checked";
  readonly outcome: "enabled" | "disabled" | "rejected";
  readonly reason: string;
  readonly schemaPath?: string;
}
export interface ToolConstraintReport {
  readonly decisions: readonly ToolConstraintDecision[];
  /** Planned request settings, not proof of server-side enforcement. */
  readonly failure?: import("../types").AgentFailure;
}

export interface ModelToolSpec {
  readonly name: string;
  readonly description: string;
  readonly schema: DeepReadonly<Record<string, unknown>>;
  readonly inputConstraint?: ToolInputConstraint;
}

export interface RuntimeModelSelection {
  vendorId: string;
  connectionId: string;
  providerId: string;
  modelId: string;
  /** Request-facing model/deployment id when it differs from the catalog model. */
  requestModelId?: string;
  settings?: Record<string, JsonValue>;
  contextWindow: number;
  /** Maximum output capacity advertised by the selected model. */
  modelMaxOutputTokens: number;
  /** Provider-derived request ceiling, narrowed only by an explicit user override.
   * Context preparation computes the actual per-call output budget. */
  requestedOutputTokens: number;
  requestHeaders?: Record<string, string | null>;
  thinkingHistoryPolicy?: ThinkingHistoryPolicy;
}

export type ThinkingHistoryPolicy = "preserve_all" | "clear_old_text";

export interface ModelRequest {
  readonly systemPrompt: string;
  readonly messages: readonly DeepReadonly<ModelContextMessage>[];
  readonly tools?: readonly ModelToolSpec[];
}

export interface ModelRequestOptions {
  readonly identity: ModelCallIdentity;
  readonly cache: ModelCacheIntent;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly maxOutputTokens: number;
  readonly credential?: { readonly type: "api_key"; readonly key: string };
}

export type ModelEvent =
  | { type: "tool_constraint_report"; report: ToolConstraintReport }
  | { type: "text_delta"; delta: string }
  | { type: "thinking_start"; contentIndex: number }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  | { type: "thinking_end"; contentIndex: number; content: string }
  | { type: "cache_report"; report: ModelCacheReport }
  | { type: "done"; message: AssistantTranscriptMessage }
  | { type: "error"; error: AssistantTranscriptMessage };

export interface ModelRuntimePort {
  stream(
    selection: RuntimeModelSelection,
    request: ModelRequest,
    options: ModelRequestOptions,
  ): AsyncIterable<ModelEvent>;
}
