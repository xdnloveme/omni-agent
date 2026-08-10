import type {
  Api,
  AssistantMessage,
  Context,
  Message,
  Tool,
  TSchema,
  Usage,
} from "@earendil-works/pi-ai";
import type { AgentMessage, AssistantAgentMessage, ModelRequest } from "@omni-agent/core";

function toBackendUsage(usage: AssistantAgentMessage["usage"]): Usage {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    reasoning: usage.reasoning,
    totalTokens:
      usage.totalTokens ?? usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
    cost: usage.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function toBackendMessages(messages: AgentMessage[]): Message[] {
  return messages.map((message): Message => {
    if (message.role === "user") {
      return {
        role: "user",
        content:
          typeof message.content === "string"
            ? message.content
            : message.content.map((content) => ({ ...content })),
        timestamp: message.timestamp,
      };
    }
    if (message.role === "toolResult") {
      return {
        role: "toolResult",
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        content: message.content.map((content) => ({ ...content })),
        details: message.details,
        usage: message.usage && toBackendUsage(message.usage),
        addedToolNames: message.addedToolNames,
        isError: message.isError,
        timestamp: message.timestamp,
      };
    }
    return {
      role: "assistant",
      content: message.content.map((content) => ({ ...content })),
      api: message.api as Api,
      provider: message.provider,
      model: message.model,
      responseModel: message.responseModel,
      responseId: message.responseId,
      diagnostics: message.diagnostics?.map((diagnostic) => ({
        ...diagnostic,
        error: diagnostic.error && { ...diagnostic.error },
        details: diagnostic.details && { ...diagnostic.details },
      })),
      usage: toBackendUsage(message.usage),
      stopReason: message.stopReason,
      deferred: message.deferred && { ...message.deferred },
      errorMessage: message.errorMessage,
      rawStopReason: message.rawStopReason,
      timestamp: message.timestamp,
    };
  });
}

export function fromBackendMessages(messages: Message[]): AgentMessage[] {
  return messages.map((message): AgentMessage => {
    if (message.role === "user") {
      return {
        role: "user",
        content:
          typeof message.content === "string"
            ? message.content
            : message.content.map((content) => ({ ...content })),
        timestamp: message.timestamp,
      };
    }
    if (message.role === "toolResult") {
      return {
        role: "toolResult",
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        content: message.content.map((content) => ({ ...content })),
        details: message.details,
        usage: message.usage && {
          input: message.usage.input,
          output: message.usage.output,
          cacheRead: message.usage.cacheRead,
          cacheWrite: message.usage.cacheWrite,
          reasoning: message.usage.reasoning,
          totalTokens: message.usage.totalTokens,
          cost: { ...message.usage.cost },
        },
        addedToolNames: message.addedToolNames,
        isError: message.isError,
        timestamp: message.timestamp,
      };
    }
    return fromBackendMessage(message);
  });
}

export function toBackendAssistantMessage(message: AssistantAgentMessage): AssistantMessage {
  const converted = toBackendMessages([message])[0];
  if (converted.role !== "assistant") throw new Error("Expected an assistant message");
  return converted;
}

export function fromBackendMessage(message: AssistantMessage): AssistantAgentMessage {
  return {
    role: "assistant",
    content: message.content.map((content) => ({ ...content })),
    api: message.api,
    provider: message.provider,
    model: message.model,
    responseModel: message.responseModel,
    responseId: message.responseId,
    diagnostics: message.diagnostics?.map((diagnostic) => ({
      ...diagnostic,
      error: diagnostic.error && { ...diagnostic.error },
      details: diagnostic.details && { ...diagnostic.details },
    })),
    usage: {
      input: message.usage.input,
      output: message.usage.output,
      cacheRead: message.usage.cacheRead,
      cacheWrite: message.usage.cacheWrite,
      reasoning: message.usage.reasoning,
      totalTokens: message.usage.totalTokens,
      cost: { ...message.usage.cost },
    },
    stopReason: message.stopReason,
    deferred: message.deferred && { ...message.deferred },
    errorMessage: message.errorMessage,
    rawStopReason: message.rawStopReason,
    timestamp: message.timestamp,
  };
}

function toBackendTools(tools: ModelRequest["tools"]): Tool[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.schema as TSchema,
  }));
}

export function toBackendContext(request: ModelRequest): Context {
  return {
    systemPrompt: request.systemPrompt,
    messages: toBackendMessages(request.messages),
    tools: toBackendTools(request.tools),
  };
}
