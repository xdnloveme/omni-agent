import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentMessage } from "../models/messages";
import type { AgentConfig, AgentEvent, RegisteredAgentTool } from "../types";
import type { ModelRuntimePort } from "../models";
import { runAgentLoop } from "../agent-loop";
import {
  SkillEventName,
  SkillEventNamespace,
  SkillReadLifecycleAdapter,
  SkillReadStatus,
} from "../skills";
import type { ToolLifecycleAdapter } from "../tool-lifecycle";
import { PermissionGate } from "../permissions";
import { ToolAuthorizationRouter, ToolCallCoordinator, ToolInputValidator } from "../tool-calls";
import { ToolInvocationRunner } from "../execution";

const streamModel = vi.fn<ModelRuntimePort["stream"]>();
const modelRuntime: ModelRuntimePort = { stream: streamModel };

function makeTool(name = "test_tool"): RegisteredAgentTool {
  return {
    name,
    originId: "test",
    toolIdentity: `test:${name}`,
    authorization: { kind: "static", risk: "read", reason: "test" },
    execution: { kind: "host" },
    timeout: { kind: "none" },
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
    model: {
      vendorId: "test",
      connectionId: "default",
      providerId: "test",
      modelId: "test-model",
      contextWindow: 128_000,
      maxOutputTokens: 4_096,
    },
    systemPrompt: "You are a test assistant.",
    tools: [makeTool()],
    ...overrides,
  };
}

function makeMessages(userContent: string): AgentMessage[] {
  return [{ role: "user", content: userContent, timestamp: Date.now() }];
}

function executeLoop(config: AgentConfig, messages: AgentMessage[], signal?: AbortSignal) {
  return runAgentLoop({
    config,
    messages,
    modelRuntime,
    agentId: "test",
    cwd: process.cwd(),
    toolCallCoordinator: createCoordinator(),
    signal,
  });
}

function createCoordinator() {
  const permissionGate = new PermissionGate({
    policy: { evaluate: () => ({ outcome: "allow", reason: "test" }) },
    grants: {
      async getMode() {
        return "standard";
      },
      async isToolAlwaysApproved() {
        return false;
      },
      async approveTool() {},
    },
    broker: {
      async request() {
        return "deny";
      },
    },
  });
  return new ToolCallCoordinator({
    authorizer: new ToolAuthorizationRouter(permissionGate),
    invocationRunner: new ToolInvocationRunner(),
    inputValidator: new ToolInputValidator(),
  });
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
    streamModel.mockReturnValue(
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
    const events = await collectEvents(executeLoop(config, makeMessages("Hi")));

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

    streamModel.mockReturnValue(
      fakeStream([
        { type: "text_delta", delta: "Hello world" },
        { type: "done", message: assistantMsg },
      ]) as any,
    );

    const config = makeConfig({ tools: [] });
    const events = await collectEvents(executeLoop(config, makeMessages("Hi")));

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
    streamModel.mockReturnValueOnce(
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
    streamModel.mockReturnValueOnce(
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

    const events = await collectEvents(executeLoop(config, makeMessages("Run a command")));

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
    expect(tool.execute).toHaveBeenCalledWith(
      { input: "test" },
      { cwd: process.cwd(), signal: expect.any(AbortSignal) },
    );

    // Verify produced messages include assistant + tool_result + assistant
    if (doneEvent.type === "done") {
      expect(doneEvent.produced).toHaveLength(3); // assistant(toolUse) + toolResult + assistant(text)
      expect(doneEvent.produced![0].role).toBe("assistant");
      expect(doneEvent.produced![1].role).toBe("toolResult");
      expect(doneEvent.produced![2].role).toBe("assistant");
    }
  });

  it("runs extension middleware around model and tool execution", async () => {
    const order: string[] = [];
    const tool = makeTool("bash");
    vi.mocked(tool.execute).mockImplementation(async () => {
      order.push("execute-tool");
      return { content: [{ type: "text", text: "ok" }], isError: false };
    });
    const config = makeConfig({
      tools: [tool],
      middleware: [
        {
          beforeModel: () => {
            order.push("before-model");
          },
          afterModel: () => {
            order.push("after-model");
          },
          beforeExecute: () => {
            order.push("before-tool");
          },
          afterExecute: () => {
            order.push("after-tool");
          },
        },
      ],
    });
    streamModel.mockReturnValueOnce(
      fakeStream([
        {
          type: "done",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", id: "call_1", name: "bash", arguments: {} }],
            stopReason: "toolUse",
            timestamp: Date.now(),
          },
        },
      ]) as any,
    );
    streamModel.mockReturnValueOnce(
      fakeStream([
        {
          type: "done",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
            stopReason: "stop",
            timestamp: Date.now(),
          },
        },
      ]) as any,
    );

    await collectEvents(executeLoop(config, makeMessages("run")));

    expect(order).toEqual([
      "before-model",
      "after-model",
      "before-tool",
      "execute-tool",
      "after-tool",
      "before-model",
      "after-model",
    ]);
  });

  it("should emit extension events around skill_read tool calls", async () => {
    const skillTool = makeTool("skill_read");
    vi.mocked(skillTool.execute).mockResolvedValue({
      content: [{ type: "text", text: "<skill>body</skill>" }],
      isError: false,
      meta: {
        kind: "skill_read",
        skillName: "frontend-design",
        status: "loaded",
        tokenEstimate: 42,
      },
    });
    const config = makeConfig({
      tools: [skillTool],
      toolLifecycleAdapters: [new SkillReadLifecycleAdapter()],
    });

    streamModel.mockReturnValueOnce(
      fakeStream([
        {
          type: "done",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call_skill",
                name: "skill_read",
                arguments: { name: "frontend-design" },
              },
            ],
            stopReason: "toolUse",
            timestamp: Date.now(),
          },
        },
      ]) as any,
    );

    streamModel.mockReturnValueOnce(
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

    const events = await collectEvents(executeLoop(config, makeMessages("Use a skill")));

    expect(events).toContainEqual({
      type: "extension_event",
      namespace: SkillEventNamespace.Skill,
      event: SkillEventName.ReadStart,
      toolCallId: "call_skill",
      payload: { skillName: "frontend-design" },
    });
    expect(events).toContainEqual({
      type: "extension_event",
      namespace: SkillEventNamespace.Skill,
      event: SkillEventName.ReadEnd,
      toolCallId: "call_skill",
      payload: expect.objectContaining({
        skillName: "frontend-design",
        status: SkillReadStatus.Loaded,
        tokenEstimate: 42,
      }),
    });
  });

  it("should continue tool-result pairing when a lifecycle adapter throws", async () => {
    const tool = makeTool("bash");
    const failingAdapter: ToolLifecycleAdapter = {
      supports: () => true,
      onStart: () => [],
      onEnd: () => {
        throw new Error("adapter failed");
      },
    };
    const config = makeConfig({
      tools: [tool],
      toolLifecycleAdapters: [failingAdapter],
    });

    streamModel.mockReturnValueOnce(
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
    streamModel.mockReturnValueOnce(
      fakeStream([
        {
          type: "done",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
            stopReason: "endTurn",
            timestamp: Date.now(),
          },
        },
      ]) as any,
    );

    const events = await collectEvents(executeLoop(config, makeMessages("Run a command")));

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool_end",
        toolCallId: "call_1",
      }),
    );
    expect(events).toContainEqual({
      type: "extension_event",
      namespace: "tool_lifecycle",
      event: "adapter_error",
      toolCallId: "call_1",
      payload: {
        toolName: "bash",
        phase: "end",
        error: "adapter failed",
      },
    });

    const doneEvent = events[events.length - 1];
    expect(doneEvent.type).toBe("done");
    if (doneEvent.type === "done") {
      expect(doneEvent.produced).toHaveLength(3);
      expect(doneEvent.produced![1]).toMatchObject({
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "bash",
      });
    }
  });

  it("should stop with error when maxTurns is reached", async () => {
    const tool = makeTool("bash");
    const config = makeConfig({ tools: [tool], maxTurns: 1 });

    // LLM always returns tool use — loop should stop after 1 turn
    streamModel.mockReturnValue(
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

    const events = await collectEvents(executeLoop(config, makeMessages("Loop forever")));

    const lastEvent = events[events.length - 1];
    expect(lastEvent).toEqual({ type: "error", error: "Max turns reached" });
  });

  it("should throw AbortError immediately when signal is already aborted", async () => {
    const config = makeConfig();
    const controller = new AbortController();
    controller.abort();

    await expect(
      collectEvents(executeLoop(config, makeMessages("Hi"), controller.signal)),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(streamModel).not.toHaveBeenCalled();
  });

  it("should yield error when LLM returns an error event", async () => {
    streamModel.mockReturnValue(
      fakeStream([{ type: "error", error: { errorMessage: "Rate limit exceeded" } }]) as any,
    );

    const config = makeConfig();
    const events = await collectEvents(executeLoop(config, makeMessages("Hi")));

    expect(events).toEqual([{ type: "error", error: "Rate limit exceeded" }]);
  });

  it("should return isError=true when tool is not found", async () => {
    const config = makeConfig({ tools: [] }); // no tools registered

    streamModel.mockReturnValueOnce(
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
    streamModel.mockReturnValueOnce(
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

    const events = await collectEvents(executeLoop(config, makeMessages("Use a tool")));

    const toolEnd = events.find((e) => e.type === "tool_end") as Extract<
      AgentEvent,
      { type: "tool_end" }
    >;
    expect(toolEnd).toBeDefined();
    expect(toolEnd.result.isError).toBe(true);
    expect(toolEnd.result.content[0].text).toContain("Tool not found");
  });

  it("should not mutate the input messages array", async () => {
    streamModel.mockReturnValue(
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

    await collectEvents(executeLoop(config, messages));

    expect(messages).toHaveLength(originalLength);
  });
});
