import type {
  Api,
  AssistantMessage,
  Context,
  Message,
  Tool,
  TSchema,
  Usage,
} from "@earendil-works/pi-ai";
import type {
  AssistantTranscriptMessage,
  DeepReadonly,
  ModelContextMessage,
  ModelRequest,
} from "@omni-agent/core";
import type { ToolResultContent } from "@omni-agent/core";

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function toBackendUsage(usage: DeepReadonly<AssistantTranscriptMessage["usage"]>): Usage {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    reasoning: usage.reasoning,
    totalTokens:
      usage.totalTokens ?? usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
    cost: usage.cost
      ? { ...usage.cost }
      : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function toBackendMessages(messages: ModelRequest["messages"]): Message[] {
  return messages.map((message): Message => {
    if (message.role === "user") {
      return {
        role: "user",
        content:
          typeof message.content === "string" ? message.content : mutableClone(message.content),
        timestamp: 0,
      } as Message;
    }
    if (message.role === "toolResult") {
      return {
        role: "toolResult",
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        content: [
          ...message.content.map(projectToolContentForBackend),
          ...(message.structuredContent === undefined
            ? []
            : [
                {
                  type: "text" as const,
                  text: `Structured tool result:\n${JSON.stringify(message.structuredContent)}`,
                },
              ]),
        ],
        details: {
          omniContent: mutableClone(message.content),
          structuredContent: mutableClone(message.structuredContent),
        },
        addedToolNames: message.addedToolNames && [...message.addedToolNames],
        isError: message.isError,
        timestamp: 0,
      } as Message;
    }
    return {
      role: "assistant",
      content: mutableClone(message.content),
      api: message.api as Api,
      provider: message.provider,
      model: message.model,
      responseModel: message.responseModel,
      usage: mutableClone(ZERO_USAGE),
      stopReason: message.stopReason,
      deferred: mutableClone(message.deferred),
      rawStopReason: message.rawStopReason,
      timestamp: 0,
    };
  });
}

function mutableClone<T>(value: unknown): T {
  return structuredClone(value) as T;
}

export function fromBackendContextMessages(messages: Message[]): ModelContextMessage[] {
  return messages.map((message): ModelContextMessage => {
    if (message.role === "user") {
      return {
        role: "user",
        content:
          typeof message.content === "string" ? message.content : mutableClone(message.content),
      };
    }
    if (message.role === "toolResult") {
      const details = isRecord(message.details) ? message.details : undefined;
      return {
        role: "toolResult",
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        content: mutableClone(
          Array.isArray(details?.omniContent) ? details.omniContent : message.content,
        ),
        ...(details?.structuredContent === undefined
          ? {}
          : { structuredContent: mutableClone(details.structuredContent) }),
        addedToolNames: message.addedToolNames && [...message.addedToolNames],
        isError: message.isError,
      };
    }
    return {
      role: "assistant",
      content: mutableClone(message.content),
      api: message.api,
      provider: message.provider,
      model: message.model,
      responseModel: message.responseModel,
      stopReason: message.stopReason,
      deferred: mutableClone(message.deferred),
      rawStopReason: message.rawStopReason,
    };
  });
}

function projectToolContentForBackend(
  block: DeepReadonly<ToolResultContent>,
): import("@earendil-works/pi-ai").TextContent | import("@earendil-works/pi-ai").ImageContent {
  if (block.annotations?.audience && !block.annotations.audience.includes("assistant")) {
    return { type: "text", text: `[${block.type} content omitted: audience=user]` };
  }
  if (block.type === "text") return { type: "text", text: block.text };
  if (block.type === "image") return { type: "image", data: block.data, mimeType: block.mimeType };
  if (block.type === "audio") {
    return {
      type: "text",
      text: `[audio: ${block.mimeType}; base64-bytes=${Buffer.byteLength(block.data, "base64")}]`,
    };
  }
  if (block.type === "resource_link") {
    return {
      type: "text",
      text: [
        `[resource: ${block.name}; uri=${block.uri}`,
        block.mimeType ? `; mime=${block.mimeType}` : "",
        block.size === undefined ? "" : `; bytes=${block.size}`,
        "]",
        block.description ? `\n${block.description}` : "",
      ].join(""),
    };
  }
  if ("text" in block.resource) {
    return {
      type: "text",
      text: `[embedded resource: ${block.resource.uri}${block.resource.mimeType ? `; mime=${block.resource.mimeType}` : ""}]\n${block.resource.text}`,
    };
  }
  return {
    type: "text",
    text: `[embedded binary resource: ${block.resource.uri}${block.resource.mimeType ? `; mime=${block.resource.mimeType}` : ""}; base64-bytes=${Buffer.byteLength(block.resource.blob, "base64")}]`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function toBackendAssistantMessage(message: AssistantTranscriptMessage): AssistantMessage {
  return {
    role: "assistant",
    content: mutableClone(message.content),
    api: message.api as Api,
    provider: message.provider,
    model: message.model,
    responseModel: message.responseModel,
    responseId: message.responseId,
    diagnostics: message.diagnostics?.map((diagnostic) => ({
      ...diagnostic,
      error: diagnostic.error && { ...diagnostic.error },
      details: mutableClone(diagnostic.details),
    })),
    usage: toBackendUsage(message.usage),
    stopReason: message.stopReason,
    deferred: mutableClone(message.deferred),
    errorMessage: message.errorMessage,
    rawStopReason: message.rawStopReason,
    timestamp: message.timestamp,
  };
}

export function fromBackendMessage(message: AssistantMessage): AssistantTranscriptMessage {
  return {
    role: "assistant",
    content: mutableClone(message.content),
    api: message.api,
    provider: message.provider,
    model: message.model,
    responseModel: message.responseModel,
    responseId: message.responseId,
    diagnostics: message.diagnostics?.map((diagnostic) => ({
      ...diagnostic,
      error: diagnostic.error && { ...diagnostic.error },
      details: mutableClone(diagnostic.details),
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
    deferred: mutableClone(message.deferred),
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
    parameters: mutableClone<TSchema>(tool.schema),
  }));
}

export function toBackendContext(request: ModelRequest): Context {
  return {
    systemPrompt: request.systemPrompt,
    messages: toBackendMessages(request.messages),
    tools: toBackendTools(request.tools),
  };
}
