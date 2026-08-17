import { describe, expect, it } from "vitest";
import type { TranscriptMessage } from "../messages";
import { toContextMessages } from "../context";

describe("message contracts", () => {
  it("projects transcript messages into detached model-only messages", () => {
    const transcript: TranscriptMessage[] = [
      { role: "user", content: "hello", timestamp: 1 },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-1",
            name: "inspect",
            arguments: { path: "README.md" },
          },
        ],
        api: "api",
        provider: "provider",
        model: "model",
        responseModel: "served-model",
        responseId: "response-1",
        stopReason: "toolUse",
        rawStopReason: "tool_use",
        deferred: {
          provider: "provider",
          modelId: "model",
          api: "api",
          id: "job-1",
          data: { nested: [1] },
        },
        usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 },
        diagnostics: [{ type: "trace", timestamp: 2 }],
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "inspect",
        content: [{ type: "text", text: "ok" }],
        details: { internal: true },
        usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
        addedToolNames: ["next"],
        isError: false,
        timestamp: 3,
      },
    ];

    const projected = toContextMessages(transcript);
    expect(projected).toEqual([
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: transcript[1].role === "assistant" ? transcript[1].content : [],
        api: "api",
        provider: "provider",
        model: "model",
        responseModel: "served-model",
        stopReason: "toolUse",
        rawStopReason: "tool_use",
        deferred: transcript[1].role === "assistant" ? transcript[1].deferred : undefined,
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "inspect",
        content: [{ type: "text", text: "ok" }],
        addedToolNames: ["next"],
        isError: false,
      },
    ]);

    const assistant = projected[1];
    if (assistant.role !== "assistant") throw new Error("Expected assistant message");
    const toolCall = assistant.content[0];
    if (toolCall.type !== "toolCall") throw new Error("Expected tool call");
    (toolCall.arguments as { path: string }).path = "changed";
    (assistant.deferred!.data as { nested: number[] }).nested[0] = 2;
    const projectedToolResult = projected[2];
    if (projectedToolResult.role !== "toolResult") throw new Error("Expected tool result");
    (projectedToolResult.addedToolNames as string[])[0] = "changed";

    const sourceAssistant = transcript[1];
    if (sourceAssistant.role !== "assistant") throw new Error("Expected assistant transcript");
    const sourceCall = sourceAssistant.content[0];
    if (sourceCall.type !== "toolCall") throw new Error("Expected source tool call");
    expect(sourceCall.arguments).toEqual({ path: "README.md" });
    expect(sourceAssistant.deferred?.data).toEqual({ nested: [1] });
    expect(transcript[2].role === "toolResult" && transcript[2].addedToolNames).toEqual(["next"]);
  });
});
