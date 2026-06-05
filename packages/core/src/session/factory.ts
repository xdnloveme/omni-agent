import type {
  Message,
  AssistantMessage,
} from "@mariozechner/pi-ai";

import type { SessionMessage } from "./types";

/**
 * Create a user message in the LLM-compatible format.
 */
export function createUserMessage(content: string): SessionMessage {
  const msg: Message = {
    role: "user",
    content,
    timestamp: Date.now(),
  };
  return msg;
}

/**
 * Create an assistant message by wrapping the raw AssistantMessage from the LLM.
 * The AssistantMessage already conforms to the Message union — pass it through.
 */
export function createAssistantMessage(assistantMessage: AssistantMessage): SessionMessage {
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
): SessionMessage {
  const msg: Message = {
    role: "toolResult",
    toolCallId,
    toolName,
    content,
    isError,
    timestamp: Date.now(),
  };
  return msg;
}
