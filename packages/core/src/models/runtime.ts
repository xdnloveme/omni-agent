import type { AgentTool } from "../types";
import type { AgentMessage, AssistantAgentMessage } from "./messages";

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

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
  systemPrompt: string;
  messages: AgentMessage[];
  tools?: AgentTool[];
}

export interface ModelRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxRetries?: number;
  credential?: { type: "api_key"; key: string };
}

export type ModelEvent =
  | { type: "text_delta"; delta: string }
  | { type: "done"; message: AssistantAgentMessage }
  | { type: "error"; error: AssistantAgentMessage };

export interface ModelRuntimePort {
  stream(
    selection: RuntimeModelSelection,
    request: ModelRequest,
    options?: ModelRequestOptions,
  ): AsyncIterable<ModelEvent>;
}
