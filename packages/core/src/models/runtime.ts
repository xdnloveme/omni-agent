import type { DeepReadonly, JsonValue } from "../data";
import type { AssistantTranscriptMessage, ModelContextMessage } from "../messages";
import type { ModelCacheIntent, ModelCacheReport } from "./cache";
import type { ModelCallIdentity } from "./call";

export interface ModelToolSpec {
  readonly name: string;
  readonly description: string;
  readonly schema: DeepReadonly<Record<string, unknown>>;
  readonly strict?: boolean;
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
  /** Output tokens reserved and requested for ordinary primary calls. */
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
  readonly maxOutputTokens?: number;
  readonly credential?: { readonly type: "api_key"; readonly key: string };
}

export type ModelEvent =
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
