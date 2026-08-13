import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TranscriptMessage } from "../messages";
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
import {
  DefaultContextEngine,
  FullHistoryContextStrategy,
  type ContextMiddlewarePort,
} from "../context";

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

function makeMessages(userContent: string): TranscriptMessage[] {
  return [{ role: "user", content: userContent, timestamp: Date.now() }];
}

function executeLoop(
  config: AgentConfig,
  messages: TranscriptMessage[],
  signal?: AbortSignal,
  contextMiddleware: readonly ContextMiddlewarePort[] = [],
) {
  return runAgentLoop({
    config,
    snapshot: {
      sessionId: "test-session",
      revision: 1,
      messages,
    },
    contextEngine: new DefaultContextEngine(new FullHistoryContextStrategy()),
    contextMiddleware,
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
      async getGrantedScopeKeys() {
        return [];
      },
      async saveGrants() {},
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
    if (event.type === "done" && event.message && typeof event.message === "object") {
      yield { ...event, message: completeAssistantMessage(event.message) };
    } else if (event.type === "error" && event.error && typeof event.error === "object") {
      yield { ...event, error: completeAssistantMessage(event.error) };
    } else {
      yield event;
    }
  }
}

function completeAssistantMessage(value: object) {
  return {
    role: "assistant",
    content: [],
    api: "test-api",
    provider: "test-provider",
    model: "test-model",
    stopReason: "stop",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    timestamp: Date.now(),
    ...value,
  };
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
      expect.objectContaining({ type: "model_context_prepared" }),
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
      expect(doneEvent!.produced![0]).toMatchObject(assistantMsg);
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

  it("runs completion and tool middleware around their owned phases", async () => {
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
      "after-model",
      "before-tool",
      "execute-tool",
      "after-tool",
      "after-model",
    ]);
  });

  it("prevents afterModel observers from mutating the response or next context", async () => {
    const tool = makeTool("bash");
    const config = makeConfig({
      tools: [tool],
      middleware: [
        {
          afterModel(context) {
            const response = context.response as unknown as {
              content: Array<{ type: string; name?: string }>;
            };
            if (response.content[0]?.type === "toolCall") response.content[0].name = "mutated";
            const request = context.request as unknown as { messages: Array<{ content: string }> };
            if (typeof request.messages[0]?.content === "string") {
              request.messages[0].content = "mutated";
            }
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
            timestamp: 1,
          },
        },
      ]) as never,
    );
    streamModel.mockReturnValueOnce(
      fakeStream([
        {
          type: "done",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
            stopReason: "stop",
            timestamp: 2,
          },
        },
      ]) as never,
    );

    const events = await collectEvents(executeLoop(config, makeMessages("run")));
    const secondRequest = streamModel.mock.calls[1]?.[1];
    expect(tool.execute).toHaveBeenCalledOnce();
    expect(secondRequest.messages[0]).toMatchObject({ content: "run" });
    expect(secondRequest.messages[1]).toMatchObject({
      role: "assistant",
      content: [expect.objectContaining({ type: "toolCall", name: "bash" })],
    });
    const done = events.at(-1);
    expect(done?.type).toBe("done");
    if (done?.type === "done") {
      expect(done.produced?.[0]).toMatchObject({
        content: [expect.objectContaining({ name: "bash" })],
      });
    }
  });

  it("prepares a new traceable snapshot after each tool result", async () => {
    const tool = makeTool("bash");
    streamModel.mockReturnValueOnce(
      fakeStream([
        {
          type: "done",
          message: {
            content: [{ type: "toolCall", id: "call_1", name: "bash", arguments: {} }],
            stopReason: "toolUse",
          },
        },
      ]) as never,
    );
    streamModel.mockReturnValueOnce(
      fakeStream([{ type: "done", message: { content: [], stopReason: "stop" } }]) as never,
    );

    const events = await collectEvents(
      executeLoop(makeConfig({ tools: [tool] }), makeMessages("run")),
    );
    const snapshots = events.filter((event) => event.type === "model_context_prepared");
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0].manifest.outputMessageCount).toBe(1);
    expect(snapshots[1].manifest.outputMessageCount).toBe(3);
    expect(snapshots[1].manifest.snapshotId).not.toBe(snapshots[0].manifest.snapshotId);
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
    expect(lastEvent).toEqual({
      type: "error",
      error: "Max turns reached (1)",
      code: "max_turns_reached",
      produced: expect.arrayContaining([
        expect.objectContaining({ role: "assistant", stopReason: "toolUse" }),
        expect.objectContaining({ role: "toolResult", toolCallId: "call_1" }),
      ]),
      usage: expect.objectContaining({ contextWindow: 128_000 }),
      turnCount: 1,
      maxTurns: 1,
    });
  });

  it("injects loop guidance into the next model request without persisting it", async () => {
    const tool = makeTool("file_read");
    const config = makeConfig({ tools: [tool] });
    let modelCall = 0;
    streamModel.mockImplementation(() => {
      modelCall += 1;
      if (modelCall <= 2) {
        return fakeStream([
          {
            type: "done",
            message: {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: `call_${modelCall}`,
                  name: "file_read",
                  arguments: { path: "same.ts" },
                },
              ],
              stopReason: "toolUse",
              timestamp: Date.now(),
            },
          },
        ]) as ReturnType<ModelRuntimePort["stream"]>;
      }
      return fakeStream([
        {
          type: "done",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
            stopReason: "stop",
            timestamp: Date.now(),
          },
        },
      ]) as ReturnType<ModelRuntimePort["stream"]>;
    });

    const events = await collectEvents(executeLoop(config, makeMessages("read twice")));
    const firstPrompt = streamModel.mock.calls[0]?.[1].systemPrompt;
    const thirdPrompt = streamModel.mock.calls[2]?.[1].systemPrompt;
    expect(firstPrompt).toContain("# Runtime Tool Loop Policy");
    expect(firstPrompt).not.toContain("<runtime-guidance");
    expect(thirdPrompt).toContain('<runtime-guidance source="loop-protection" severity="soft">');

    const done = events.at(-1);
    expect(done?.type).toBe("done");
    if (done?.type === "done") {
      expect(JSON.stringify(done.produced)).not.toContain("runtime-guidance");
    }
  });

  it("halts only after every tool result in the repeated batch is produced", async () => {
    const read = makeTool("file_read");
    const grep = makeTool("grep");
    const config = makeConfig({ tools: [read, grep] });
    let modelCall = 0;
    streamModel.mockImplementation(() => {
      modelCall += 1;
      return fakeStream([
        {
          type: "done",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: `read_${modelCall}`,
                name: "file_read",
                arguments: { path: "same.ts" },
              },
              {
                type: "toolCall",
                id: `grep_${modelCall}`,
                name: "grep",
                arguments: { pattern: "same" },
              },
            ],
            stopReason: "toolUse",
            timestamp: Date.now(),
          },
        },
      ]) as ReturnType<ModelRuntimePort["stream"]>;
    });

    const events = await collectEvents(executeLoop(config, makeMessages("loop")));
    const terminal = events.at(-1);
    expect(streamModel).toHaveBeenCalledTimes(4);
    expect(read.execute).toHaveBeenCalledTimes(4);
    expect(grep.execute).toHaveBeenCalledTimes(4);
    expect(terminal).toMatchObject({
      type: "error",
      code: "tool_loop_detected",
      loop: { kind: "repeated_batch", count: 4, period: 1 },
      produced: expect.any(Array),
    });
    if (terminal?.type === "error") {
      expect(terminal.produced).toHaveLength(12);
    }
  });

  it("lets a confirmed alternating cycle finish its fourth period before halting", async () => {
    const read = makeTool("file_read");
    const grep = makeTool("grep");
    const config = makeConfig({ tools: [read, grep] });
    let modelCall = 0;
    streamModel.mockImplementation(() => {
      modelCall += 1;
      const isRead = modelCall % 2 === 1;
      return fakeStream([
        {
          type: "done",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: `call_${modelCall}`,
                name: isRead ? "file_read" : "grep",
                arguments: isRead ? { path: "same.ts" } : { pattern: "same" },
              },
            ],
            stopReason: "toolUse",
            timestamp: Date.now(),
          },
        },
      ]) as ReturnType<ModelRuntimePort["stream"]>;
    });

    const events = await collectEvents(executeLoop(config, makeMessages("alternate")));
    const terminal = events.at(-1);
    expect(streamModel).toHaveBeenCalledTimes(8);
    expect(read.execute).toHaveBeenCalledTimes(4);
    expect(grep.execute).toHaveBeenCalledTimes(4);
    expect(terminal).toMatchObject({
      type: "error",
      code: "tool_loop_detected",
      loop: { kind: "alternating_batch", count: 4, period: 2 },
    });
  });

  it("allows an unbounded agent to continue beyond thirty model calls", async () => {
    const tool = makeTool("bash");
    const config = makeConfig({ tools: [tool], maxTurns: undefined });
    let modelCall = 0;
    streamModel.mockImplementation(() => {
      modelCall += 1;
      if (modelCall <= 31) {
        return fakeStream([
          {
            type: "done",
            message: {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: `call_${modelCall}`,
                  name: "bash",
                  arguments: { input: `step-${modelCall}` },
                },
              ],
              stopReason: "toolUse",
              timestamp: Date.now(),
            },
          },
        ]) as ReturnType<ModelRuntimePort["stream"]>;
      }
      return fakeStream([
        {
          type: "done",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "finished" }],
            stopReason: "stop",
            timestamp: Date.now(),
          },
        },
      ]) as ReturnType<ModelRuntimePort["stream"]>;
    });

    const events = await collectEvents(executeLoop(config, makeMessages("long task")));
    expect(streamModel).toHaveBeenCalledTimes(32);
    expect(events.at(-1)?.type).toBe("done");
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

    expect(events.filter((event) => event.type === "error")).toEqual([
      { type: "error", error: "Rate limit exceeded" },
    ]);
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
