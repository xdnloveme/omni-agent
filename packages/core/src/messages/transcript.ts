import type { DeepReadonly, JsonValue } from "../data";
import { cloneData } from "../dataCopy";
import type { ImageContent, TextContent, ThinkingContent, ToolCallContent } from "./content";

export const MessageRole = {
  User: "user",
  Assistant: "assistant",
  ToolResult: "toolResult",
} as const;

export interface ModelUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
  totalTokens?: number;
  cost?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export interface ModelDiagnostic {
  type: string;
  timestamp: number;
  error?: {
    name?: string;
    message: string;
    stack?: string;
    code?: string | number;
  };
  details?: Record<string, unknown>;
}

export interface DeferredModelResponse {
  provider: string;
  modelId: string;
  api: string;
  id: string;
  expiresAt?: number;
  pollAfterMs?: number;
  data?: JsonValue;
}

export interface UserTranscriptMessage {
  role: "user";
  content: string | Array<TextContent | ImageContent>;
  timestamp: number;
}

export interface AssistantTranscriptMessage {
  role: "assistant";
  content: Array<TextContent | ThinkingContent | ToolCallContent>;
  api: string;
  provider: string;
  model: string;
  responseModel?: string;
  stopReason: "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";
  usage: ModelUsage;
  timestamp: number;
  responseId?: string;
  diagnostics?: ModelDiagnostic[];
  deferred?: DeferredModelResponse;
  errorMessage?: string;
  rawStopReason?: string;
}

export interface ToolResultTranscriptMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: Array<TextContent | ImageContent>;
  details?: JsonValue;
  usage?: ModelUsage;
  addedToolNames?: string[];
  isError: boolean;
  timestamp: number;
}

export type TranscriptMessage =
  UserTranscriptMessage | AssistantTranscriptMessage | ToolResultTranscriptMessage;

export function cloneTranscriptMessage<T extends TranscriptMessage>(message: DeepReadonly<T>): T {
  return cloneData(message) as T;
}

export function cloneTranscriptMessages(
  messages: readonly DeepReadonly<TranscriptMessage>[],
): TranscriptMessage[] {
  return messages.map((message) => cloneTranscriptMessage(message));
}

export function assertTranscriptMessages(
  messages: readonly unknown[],
  error: (message: string) => Error,
): asserts messages is readonly TranscriptMessage[] {
  for (const message of messages) {
    if (!message || typeof message !== "object") throw error("contains an invalid message");
    const candidate = message as Record<string, unknown>;
    if (!Number.isFinite(candidate.timestamp)) throw error("contains a message without timestamp");
    if (candidate.role === "user") {
      if (typeof candidate.content !== "string" && !Array.isArray(candidate.content)) {
        throw error("contains an invalid user message");
      }
      continue;
    }
    if (candidate.role === "assistant") {
      if (
        !Array.isArray(candidate.content) ||
        typeof candidate.api !== "string" ||
        typeof candidate.provider !== "string" ||
        typeof candidate.model !== "string" ||
        typeof candidate.stopReason !== "string" ||
        !candidate.usage ||
        typeof candidate.usage !== "object"
      ) {
        throw error("contains an invalid assistant message");
      }
      continue;
    }
    if (candidate.role === "toolResult") {
      if (
        typeof candidate.toolCallId !== "string" ||
        typeof candidate.toolName !== "string" ||
        !Array.isArray(candidate.content) ||
        typeof candidate.isError !== "boolean"
      ) {
        throw error("contains an invalid tool-result message");
      }
      continue;
    }
    throw error("contains a message with an unknown role");
  }
}
