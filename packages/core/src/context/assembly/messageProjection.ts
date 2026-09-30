import { cloneData } from "../../dataCopy";
import type {
  AssistantTranscriptMessage,
  AssistantModelContextMessage,
  ModelContextMessage,
  ToolResultModelContextMessage,
  ToolResultTranscriptMessage,
  TranscriptMessage,
  UserModelContextMessage,
  UserTranscriptMessage,
} from "../../messages";

export function toContextMessages(messages: readonly TranscriptMessage[]): ModelContextMessage[] {
  return messages.map(projectMessage);
}

function projectMessage(message: TranscriptMessage): ModelContextMessage {
  switch (message.role) {
    case "user":
      return projectUserMessage(message);
    case "assistant":
      return projectAssistantMessage(message);
    case "toolResult":
      return projectToolResultMessage(message);
  }
}

function projectUserMessage(message: UserTranscriptMessage): UserModelContextMessage {
  return { role: message.role, content: cloneData(message.content) };
}

function projectAssistantMessage(
  message: AssistantTranscriptMessage,
): AssistantModelContextMessage {
  // A signed envelope cannot be selectively rewritten, including on a later Run.
  if (
    message.stopReason === "length" &&
    message.content.some((block) => block.type === "toolCall") &&
    message.content.some((block) =>
      block.type === "thinking"
        ? !!block.thinkingSignature
        : block.type === "text"
          ? !!block.textSignature
          : !!block.thoughtSignature,
    )
  ) {
    throw new Error("Cannot safely project truncated signed tool output");
  }
  return {
    role: message.role,
    // Truncated calls have no tool results and must never become pending provider calls.
    content: cloneData(
      message.stopReason === "length"
        ? message.content.filter((block) => block.type !== "toolCall")
        : message.content,
    ),
    api: message.api,
    provider: message.provider,
    model: message.model,
    responseModel: message.responseModel,
    stopReason: message.stopReason,
    deferred: message.deferred === undefined ? undefined : cloneData(message.deferred),
    rawStopReason: message.rawStopReason,
  };
}

function projectToolResultMessage(
  message: ToolResultTranscriptMessage,
): ToolResultModelContextMessage {
  return {
    role: message.role,
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    content: cloneData(message.content),
    structuredContent:
      message.structuredContent === undefined ? undefined : cloneData(message.structuredContent),
    addedToolNames: message.addedToolNames === undefined ? undefined : [...message.addedToolNames],
    isError: message.isError,
  };
}
