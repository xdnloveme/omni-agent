import type { TranscriptMessage, AssistantTranscriptMessage } from "../messages";

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
  content: Array<{ type: "text"; text: string }>,
  isError: boolean,
): TranscriptMessage {
  const msg: TranscriptMessage = {
    role: "toolResult",
    toolCallId,
    toolName,
    content,
    isError,
    timestamp: Date.now(),
  };
  return msg;
}
