import { resolveToolConstraints } from "../runtime/tool-constraints";
import { describe, expect, it } from "vitest";
import type { ModelContextMessage } from "@omni-agent/core";
import {
  fromBackendContextMessages,
  toBackendContext,
  toBackendMessages,
} from "../runtime/message-mapper";

describe("model message boundary", () => {
  it("round-trips model context while adding only backend transport placeholders", () => {
    const messages: ModelContextMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "inspect" },
          { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "reasoning",
            thinkingSignature: "thinking-signature",
            redacted: false,
          },
          {
            type: "toolCall",
            id: "call-1",
            name: "inspect",
            arguments: { path: "README.md" },
            thoughtSignature: "tool-signature",
          },
        ],
        api: "test-api",
        provider: "test-provider",
        model: "test-model",
        responseModel: "response-model",
        stopReason: "deferred",
        deferred: {
          provider: "test-provider",
          modelId: "test-model",
          api: "test-api",
          id: "job-1",
          data: { region: "cn" },
        },
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "inspect",
        content: [{ type: "image", data: "cmVzdWx0", mimeType: "image/png" }],
        addedToolNames: ["follow_up"],
        isError: false,
      },
    ];

    const backend = toBackendMessages(messages);
    expect(fromBackendContextMessages(backend)).toEqual(messages);
    expect(backend).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "inspect" },
          { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
        ],
        timestamp: 0,
      },
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "reasoning",
            thinkingSignature: "thinking-signature",
            redacted: false,
          },
          {
            type: "toolCall",
            id: "call-1",
            name: "inspect",
            arguments: { path: "README.md" },
            thoughtSignature: "tool-signature",
          },
        ],
        api: "test-api",
        provider: "test-provider",
        model: "test-model",
        responseModel: "response-model",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "deferred",
        deferred: {
          provider: "test-provider",
          modelId: "test-model",
          api: "test-api",
          id: "job-1",
          data: { region: "cn" },
        },
        rawStopReason: undefined,
        timestamp: 0,
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "inspect",
        content: [{ type: "image", data: "cmVzdWx0", mimeType: "image/png" }],
        details: {
          omniContent: [{ type: "image", data: "cmVzdWx0", mimeType: "image/png" }],
          structuredContent: undefined,
        },
        addedToolNames: ["follow_up"],
        isError: false,
        timestamp: 0,
      },
    ]);

    const backendAssistant = backend[1];
    if (backendAssistant.role !== "assistant") throw new Error("Expected assistant message");
    const backendCall = backendAssistant.content[1];
    if (backendCall.type !== "toolCall") throw new Error("Expected tool call");
    (backendCall.arguments as { path: string }).path = "changed";
    (backendAssistant.deferred?.data as { region: string }).region = "us";
    expect(
      messages[1].role === "assistant" && messages[1].content[1].type === "toolCall"
        ? messages[1].content[1].arguments
        : undefined,
    ).toEqual({ path: "README.md" });
    expect(messages[1].role === "assistant" && messages[1].deferred?.data).toEqual({
      region: "cn",
    });
  });

  it("projects rich ToolResult content to the backend contract without losing the original", () => {
    const messages: ModelContextMessage[] = [
      {
        role: "toolResult",
        toolCallId: "call-rich",
        toolName: "mcp__media__read",
        content: [
          { type: "text", text: "private text", annotations: { audience: ["user"] } },
          {
            type: "image",
            data: "aW1hZ2U=",
            mimeType: "image/png",
            annotations: { audience: ["user"] },
          },
          { type: "audio", data: "YXVkaW8=", mimeType: "audio/wav" },
          {
            type: "resource_link",
            name: "private",
            uri: "https://example.com/private",
            annotations: { audience: ["user"] },
          },
          {
            type: "resource",
            resource: { uri: "file:///notes.txt", mimeType: "text/plain", text: "notes" },
          },
        ],
        structuredContent: { answer: 42 },
        isError: false,
      },
    ];
    const backend = toBackendMessages(messages);
    const result = backend[0];
    if (result.role !== "toolResult") throw new Error("Expected tool result");
    expect(result.content).toEqual([
      { type: "text", text: "[text content omitted: audience=user]" },
      { type: "text", text: "[image content omitted: audience=user]" },
      { type: "text", text: "[audio: audio/wav; base64-bytes=5]" },
      { type: "text", text: "[resource_link content omitted: audience=user]" },
      {
        type: "text",
        text: "[embedded resource: file:///notes.txt; mime=text/plain]\nnotes",
      },
      { type: "text", text: 'Structured tool result:\n{"answer":42}' },
    ]);
    expect(fromBackendContextMessages(backend)).toEqual(messages);
  });
});

describe("model request boundary", () => {
  it("maps model-only tool specifications without executable capabilities", () => {
    const request = {
      systemPrompt: "system",
      messages: [{ role: "user", content: "hello" }],
      tools: [
        {
          name: "inspect",
          description: "Inspect",
          schema: { type: "object", properties: { path: { type: "string" } } },
          inputConstraint: "prefer",
        },
      ],
    } as const;
    const context = toBackendContext(
      request,
      resolveToolConstraints(request.tools, "openai-completions", {
        state: "unknown",
        source: "unknown",
      }).decisions,
    );

    (
      context.tools?.[0].parameters as unknown as {
        properties: Record<string, { type: string }>;
      }
    ).properties.path.type = "number";

    expect(request.tools[0].schema.properties.path.type).toBe("string");
    expect(context).toEqual({
      systemPrompt: "system",
      messages: [{ role: "user", content: "hello", timestamp: 0 }],
      tools: [
        {
          name: "inspect",
          description: "Inspect",
          parameters: { type: "object", properties: { path: { type: "number" } } },
          constrainedSampling: false,
        },
      ],
    });
  });
});
