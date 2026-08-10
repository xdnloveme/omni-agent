import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@omni-agent/core";
import { fromBackendMessages, toBackendMessages } from "../runtime/message-mapper";

describe("model message boundary", () => {
  it("round-trips images, thinking, tool calls, signatures, deferred metadata, and usage", () => {
    const usage = {
      input: 10,
      output: 5,
      cacheRead: 3,
      cacheWrite: 2,
      reasoning: 4,
      totalTokens: 20,
      cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
    };
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "inspect" },
          { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
        ],
        timestamp: 1,
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
        responseId: "response-1",
        usage,
        stopReason: "deferred",
        deferred: {
          provider: "test-provider",
          modelId: "test-model",
          api: "test-api",
          id: "job-1",
          data: { region: "cn" },
        },
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "inspect",
        content: [{ type: "image", data: "cmVzdWx0", mimeType: "image/png" }],
        details: { source: "fixture" },
        usage,
        addedToolNames: ["follow_up"],
        isError: false,
        timestamp: 3,
      },
    ];

    expect(fromBackendMessages(toBackendMessages(messages))).toEqual(messages);
  });
});
