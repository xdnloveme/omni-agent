import type {
  TranscriptMessage,
  AssistantTranscriptMessage,
  ImageContent,
  TextContent,
} from "../messages";
import type { JsonValue } from "../data";

/**
 * Create a user message in the stable transcript wire format.
 */
export function createUserMessage(content: string): TranscriptMessage {
  const msg: TranscriptMessage = {
    role: "user",
    content,
    timestamp: Date.now(),
  };
  return msg;
}

/**
 * Store a normalized assistant message without changing its wire representation.
 */
export function createAssistantMessage(
  assistantMessage: AssistantTranscriptMessage,
): TranscriptMessage {
  return assistantMessage;
}

/**
 * Create a tool result message in the LLM-compatible format.
 */
export function createToolResultMessage(
  toolCallId: string,
  toolName: string,
  content: Array<TextContent | ImageContent>,
  isError: boolean,
  structuredContent?: JsonValue,
): TranscriptMessage {
  const msg: TranscriptMessage = {
    role: "toolResult",
    toolCallId,
    toolName,
    content,
    ...(structuredContent === undefined ? {} : { structuredContent }),
    isError,
    timestamp: Date.now(),
  };
  return msg;
}
