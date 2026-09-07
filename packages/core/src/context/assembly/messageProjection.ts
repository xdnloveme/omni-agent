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
  return {
    role: message.role,
    content: cloneData(message.content),
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
