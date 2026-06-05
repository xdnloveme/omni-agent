import type {
  AssistantMessage,
  Message,
  ToolResultMessage,
  UserMessage,
} from "@mariozechner/pi-ai";

/**
 * Strip metadata fields from messages before passing to the LLM.
 *
 * pi-ai internally re-serializes messages for each provider, so fields like
 * `usage`, `responseId`, `errorMessage`, `timestamp`, and `details` are never
 * sent over the wire. Removing them reduces memory pressure and avoids
 * inflating token-count estimates.
 *
 * Fields intentionally KEPT (used by pi-ai's transformMessages pipeline):
 * - AssistantMessage: api, provider, model, stopReason (cross-model thinking logic + error skipping)
 * - ToolResultMessage: toolName (used by OpenAI/Google/Mistral providers)
 */
export function toContextMessages(messages: Message[]): Message[] {
  return messages.map(stripMessage);
}

function stripMessage(msg: Message): Message {
  switch (msg.role) {
    case "user":
      return stripUserMessage(msg);
    case "assistant":
      return stripAssistantMessage(msg);
    case "toolResult":
      return stripToolResultMessage(msg as ToolResultMessage);
  }
}

function stripUserMessage(msg: UserMessage): UserMessage {
  return {
    role: msg.role,
    content: msg.content,
    timestamp: 0,
  };
}

function stripAssistantMessage(msg: AssistantMessage): AssistantMessage {
  return {
    role: msg.role,
    content: msg.content,
    api: msg.api,
    provider: msg.provider,
    model: msg.model,
    stopReason: msg.stopReason,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    timestamp: 0,
  };
}

function stripToolResultMessage(msg: ToolResultMessage): ToolResultMessage {
  return {
    role: msg.role,
    toolCallId: msg.toolCallId,
    toolName: msg.toolName,
    content: msg.content,
    isError: msg.isError,
    timestamp: 0,
  };
}
