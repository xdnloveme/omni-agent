import type {
  AgentMessage,
  AssistantAgentMessage,
  ToolResultAgentMessage,
  UserAgentMessage,
} from "./models/messages";

/**
 * Strip metadata fields from messages before passing to the LLM.
 *
 * Provider implementations re-serialize messages for transport, so fields like
 * transport-only metadata such as `usage`, diagnostics and timestamps are never
 * sent over the wire. Removing them reduces memory pressure and avoids
 * inflating token-count estimates.
 *
 * Fields intentionally kept for provider message transformations:
 * - AssistantMessage: api, provider, model, stopReason (cross-model thinking logic + error skipping)
 * - ToolResultMessage: toolName (used by OpenAI/Google/Mistral providers)
 */
export function toContextMessages(messages: AgentMessage[]): AgentMessage[] {
  return messages.map(stripMessage);
}

function stripMessage(msg: AgentMessage): AgentMessage {
  switch (msg.role) {
    case "user":
      return stripUserMessage(msg);
    case "assistant":
      return stripAssistantMessage(msg);
    case "toolResult":
      return stripToolResultMessage(msg);
  }
}

function stripUserMessage(msg: UserAgentMessage): UserAgentMessage {
  return {
    role: msg.role,
    content: msg.content,
    timestamp: 0,
  };
}

function stripAssistantMessage(msg: AssistantAgentMessage): AssistantAgentMessage {
  return {
    role: msg.role,
    content: msg.content,
    api: msg.api,
    provider: msg.provider,
    model: msg.model,
    responseModel: msg.responseModel,
    stopReason: msg.stopReason,
    deferred: msg.deferred,
    rawStopReason: msg.rawStopReason,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: 0,
  };
}

function stripToolResultMessage(msg: ToolResultAgentMessage): ToolResultAgentMessage {
  return {
    role: msg.role,
    toolCallId: msg.toolCallId,
    toolName: msg.toolName,
    content: msg.content,
    addedToolNames: msg.addedToolNames,
    isError: msg.isError,
    timestamp: 0,
  };
}
