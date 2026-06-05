import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentConfig, AgentEvent, AgentTool, Message } from "../types.js";

// Mock the llm module
vi.mock("../llm.js", () => ({
  streamLLM: vi.fn(),
}));

import { streamLLM } from "../llm.js";
import { runAgentLoop } from "../agent-loop.js";

const mockedStreamLLM = vi.mocked(streamLLM);

function makeTool(name = "test_tool"): AgentTool {
  return {
    name,
    description: "A test tool",
    schema: { type: "object", properties: { input: { type: "string" } } },
    execute: vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "tool result" }],
      isError: false,
    }),
  };
}

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    model: "test-model",
    apiKey: "test-key",
    systemPrompt: "You are a test assistant.",
    tools: [makeTool()],
    ...overrides,
  };
}

function makeMessages(userContent: string): Message[] {
  return [{ role: "user", content: userContent, timestamp: Date.now() }];
}

/**
 * Helper: create an async iterable from an array of events.
 */
async function* fakeStream(events: Array<{ type: string; [key: string]: unknown }>) {
  for (const event of events) {
    yield event;
  }
}

/**
 * Helper: collect all events from the agent loop generator.
 */
async function collectEvents(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

describe("runAgentLoop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should yield text_delta and done for a normal text response", async () => {
    mockedStreamLLM.mockReturnValue(
      fakeStream([
        { type: "text_delta", delta: "Hello " },
        { type: "text_delta", delta: "world" },
        {
          type: "done",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Hello world" }],
            stopReason: "endTurn",
            timestamp: Date.now(),
          },
        },
      ]) as any,
    );

    const config = makeConfig({ tools: [] });
    const events = await collectEvents(runAgentLoop(config, makeMessages("Hi")));

    expect(events).toEqual([
      { type: "text_delta", delta: "Hello " },
      { type: "text_delta", delta: "world" },
      expect.objectContaining({ type: "done" }),
    ]);
  });

  it("should return produced messages on done event", async () => {
    const assistantMsg = {
      role: "assistant",
      content: [{ type: "text", text: "Hello world" }],
      stopReason: "endTurn",
      timestamp: Date.now(),
    };

    mockedStreamLLM.mockReturnValue(
      fakeStream([
        { type: "text_delta", delta: "Hello world" },
        { type: "done", message: assistantMsg },
      ]) as any,
    );

    const config = makeConfig({ tools: [] });
    const events = await collectEvents(runAgentLoop(config, makeMessages("Hi")));

    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();
    expect(doneEvent!.type).toBe("done");
    if (doneEvent!.type === "done") {
      expect(doneEvent!.produced).toHaveLength(1);
      expect(doneEvent!.produced![0]).toEqual(assistantMsg);
    }
  });

  it("should handle tool call flow: tool_start → tool_end → continue → done", async () => {
    const tool = makeTool("bash");
    const config = makeConfig({ tools: [tool] });

    // First call: LLM returns a tool use
    mockedStreamLLM.mockReturnValueOnce(
      fakeStream([
        {
          type: "done",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call_1",
                name: "bash",
                arguments: { input: "test" },
              },
            ],
            stopReason: "toolUse",
            timestamp: Date.now(),
          },
        },
      ]) as any,
    );

    // Second call: LLM returns text
    mockedStreamLLM.mockReturnValueOnce(
      fakeStream([
        { type: "text_delta", delta: "Done!" },
        {
          type: "done",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Done!" }],
            stopReason: "endTurn",
            timestamp: Date.now(),
          },
        },
      ]) as any,
    );

    const events = await collectEvents(runAgentLoop(config, makeMessages("Run a command")));

    // Verify tool_start and tool_end events
    const toolStart = events.find((e) => e.type === "tool_start");
    expect(toolStart).toBeDefined();
    expect(toolStart).toMatchObject({
      type: "tool_start",
      toolName: "bash",
      toolCallId: "call_1",
    });

    const toolEnd = events.find((e) => e.type === "tool_end");
    expect(toolEnd).toBeDefined();
    expect(toolEnd).toMatchObject({
      type: "tool_end",
      toolName: "bash",
      toolCallId: "call_1",
      result: { content: [{ type: "text", text: "tool result" }], isError: false },
    });

    // Verify the loop continued and yielded text + done
    const doneEvent = events[events.length - 1];
    expect(doneEvent.type).toBe("done");
    expect(tool.execute).toHaveBeenCalledWith({ input: "test" }, undefined);

    // Verify produced messages include assistant + tool_result + assistant
    if (doneEvent.type === "done") {
      expect(doneEvent.produced).toHaveLength(3); // assistant(toolUse) + toolResult + assistant(text)
      expect(doneEvent.produced![0].role).toBe("assistant");
      expect(doneEvent.produced![1].role).toBe("toolResult");
      expect(doneEvent.produced![2].role).toBe("assistant");
    }
  });

  it("should stop with error when maxTurns is reached", async () => {
    const tool = makeTool("bash");
    const config = makeConfig({ tools: [tool], maxTurns: 1 });

    // LLM always returns tool use — loop should stop after 1 turn
    mockedStreamLLM.mockReturnValue(
      fakeStream([
        {
          type: "done",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call_1",
                name: "bash",
                arguments: { input: "test" },
              },
            ],
            stopReason: "toolUse",
            timestamp: Date.now(),
          },
        },
      ]) as any,
    );

    const events = await collectEvents(runAgentLoop(config, makeMessages("Loop forever")));

    const lastEvent = events[events.length - 1];
    expect(lastEvent).toEqual({ type: "error", error: "Max turns reached" });
  });

  it("should yield error immediately when signal is already aborted", async () => {
    const config = makeConfig();
    const controller = new AbortController();
    controller.abort();

    const events = await collectEvents(runAgentLoop(config, makeMessages("Hi"), controller.signal));

    expect(events).toEqual([{ type: "error", error: "Aborted" }]);
    expect(mockedStreamLLM).not.toHaveBeenCalled();
  });

  it("should yield error when LLM returns an error event", async () => {
    mockedStreamLLM.mockReturnValue(
      fakeStream([
        { type: "error", error: { errorMessage: "Rate limit exceeded" } },
      ]) as any,
    );

    const config = makeConfig();
    const events = await collectEvents(runAgentLoop(config, makeMessages("Hi")));

    expect(events).toEqual([{ type: "error", error: "Rate limit exceeded" }]);
  });

  it("should return isError=true when tool is not found", async () => {
    const config = makeConfig({ tools: [] }); // no tools registered

    mockedStreamLLM.mockReturnValueOnce(
      fakeStream([
        {
          type: "done",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call_1",
                name: "nonexistent_tool",
                arguments: {},
              },
            ],
            stopReason: "toolUse",
            timestamp: Date.now(),
          },
        },
      ]) as any,
    );

    // Second call returns done so loop ends
    mockedStreamLLM.mockReturnValueOnce(
      fakeStream([
        {
          type: "done",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "ok" }],
            stopReason: "endTurn",
            timestamp: Date.now(),
          },
        },
      ]) as any,
    );

    const events = await collectEvents(runAgentLoop(config, makeMessages("Use a tool")));

    const toolEnd = events.find((e) => e.type === "tool_end") as Extract<AgentEvent, { type: "tool_end" }>;
    expect(toolEnd).toBeDefined();
    expect(toolEnd.result.isError).toBe(true);
    expect(toolEnd.result.content[0].text).toContain("Tool not found");
  });

  it("should not mutate the input messages array", async () => {
    mockedStreamLLM.mockReturnValue(
      fakeStream([
        { type: "text_delta", delta: "Hi" },
        {
          type: "done",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Hi" }],
            stopReason: "endTurn",
            timestamp: Date.now(),
          },
        },
      ]) as any,
    );

    const config = makeConfig({ tools: [] });
    const messages = makeMessages("Hello");
    const originalLength = messages.length;

    await collectEvents(runAgentLoop(config, messages));

    expect(messages).toHaveLength(originalLength);
  });
});
