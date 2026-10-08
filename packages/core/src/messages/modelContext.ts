import type { DeepReadonly } from "../data";
import type { JsonValue } from "../data";
import type { ImageContent, TextContent, ThinkingContent, ToolCallContent } from "./content";
import type { AssistantTranscriptMessage, DeferredModelResponse } from "./transcript";
import type { ToolResultContent } from "../types";

export interface UserModelContextMessage {
  readonly role: "user";
  readonly content: string | readonly DeepReadonly<TextContent | ImageContent>[];
}

export interface AssistantModelContextMessage {
  readonly role: "assistant";
  readonly content: readonly DeepReadonly<TextContent | ThinkingContent | ToolCallContent>[];
  readonly api: string;
  readonly provider: string;
  readonly model: string;
  readonly responseModel?: string;
  readonly stopReason: AssistantTranscriptMessage["stopReason"];
  readonly deferred?: DeepReadonly<DeferredModelResponse>;
  readonly rawStopReason?: string;
}

export interface ToolResultModelContextMessage {
  readonly role: "toolResult";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly content: readonly DeepReadonly<ToolResultContent>[];
  readonly structuredContent?: DeepReadonly<JsonValue>;
  readonly addedToolNames?: readonly string[];
  readonly isError: boolean;
}

export type ModelContextMessage =
  UserModelContextMessage | AssistantModelContextMessage | ToolResultModelContextMessage;
