import type { AgentMessage, AssistantAgentMessage } from "../models/messages";
import type { SessionMessage } from "./types";

/**
 * Create a user message in the stable agent message format.
 */
export function createUserMessage(content: string): SessionMessage {
  const msg: AgentMessage = {
    role: "user",
    content,
    timestamp: Date.now(),
  };
  return msg;
}

/**
 * Store a normalized assistant message without changing its wire representation.
 */
export function createAssistantMessage(assistantMessage: AssistantAgentMessage): SessionMessage {
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
  const msg: AgentMessage = {
    role: "toolResult",
    toolCallId,
    toolName,
    content,
    isError,
    timestamp: Date.now(),
  };
  return msg;
}
