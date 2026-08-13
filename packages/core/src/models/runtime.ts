import type { DeepReadonly, JsonValue } from "../data";
import type { AssistantTranscriptMessage, ModelContextMessage } from "../messages";

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
  maxOutputTokens: number;
  requestHeaders?: Record<string, string | null>;
}

export interface ModelRequest {
  readonly systemPrompt: string;
  readonly messages: readonly DeepReadonly<ModelContextMessage>[];
  readonly tools?: readonly ModelToolSpec[];
}

export interface ModelRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxRetries?: number;
  credential?: { type: "api_key"; key: string };
}

export type ModelEvent =
  | { type: "text_delta"; delta: string }
  | { type: "done"; message: AssistantTranscriptMessage }
  | { type: "error"; error: AssistantTranscriptMessage };

export interface ModelRuntimePort {
  stream(
    selection: RuntimeModelSelection,
    request: ModelRequest,
    options?: ModelRequestOptions,
  ): AsyncIterable<ModelEvent>;
}
