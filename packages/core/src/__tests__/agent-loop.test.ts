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
  ApproximateContextTokenEstimator,
  ContextPolicyPipeline,
  type ContextEnginePort,
  type ContextMiddlewarePort,
} from "../context";
import {
  EnvironmentContextController,
  type EnvironmentContextRecord,
  type RuntimeEnvironmentSnapshot,
} from "../environment";
import type { SessionRecord } from "../session";
import { digestStableValue } from "../valueDigest";

const streamModel = vi.fn<ModelRuntimePort["stream"]>();
const modelRuntime: ModelRuntimePort = { stream: streamModel };
const TEST_ENVIRONMENT_SNAPSHOT: RuntimeEnvironmentSnapshot = {
  workspace: { cwd: process.cwd(), roots: [process.cwd()] },
  time: { currentDate: "2026-08-17", timezone: "UTC" },
  execution: { platform: "linux", arch: "x64", shell: "sh", kind: "host" },
};
const TEST_ENVIRONMENT: EnvironmentContextRecord = {
  revision: 1,
  fingerprint: digestStableValue(TEST_ENVIRONMENT_SNAPSHOT),
  capturedAt: 0,
  snapshot: TEST_ENVIRONMENT_SNAPSHOT,
};

function makeTool(name = "test_tool"): RegisteredAgentTool {
  return {
    name,
    originId: "test",
    toolIdentity: `test:${name}`,
    authorization: { kind: "static", risk: "read", reason: "test" },
    execution: { kind: "host" },
    invocation: { action: "execute", resource: { kind: "command", inputKey: "input" } },
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
      modelMaxOutputTokens: 4_096,
      requestedOutputTokens: 4_096,
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
  contextEngine: ContextEnginePort = createContextEngine(),
) {
  return runAgentLoop({
    config,
    snapshot: {
      sessionId: "test-session",
      revision: 1,
      messages,
      environment: TEST_ENVIRONMENT,
    },
    contextEngine,
    contextMiddleware,
    modelRuntime,
    agentId: "test",
    environmentContext: {
      async capture() {
        return { changed: false as const };
      },
    },
    toolCallCoordinator: createCoordinator(),
    signal,
  });
}

function createContextEngine(): ContextEnginePort {
  return new DefaultContextEngine(
    new ContextPolicyPipeline(
      [],
      {
        name: "test_final_gate",
        version: 1,
        async apply(frame) {
          return { frame: structuredClone(frame) as never, decisions: [] };
        },
      },
      new ApproximateContextTokenEstimator(),
    ),
  );
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

function producedMessages(records: readonly SessionRecord[] | undefined): TranscriptMessage[] {
  return records?.flatMap((record) => (record.kind === "message" ? [record.message] : [])) ?? [];
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
    expect(streamModel.mock.calls[0]?.[2].maxOutputTokens).toBe(config.model.requestedOutputTokens);
  });

  it("forwards thinking lifecycle events with the prepared model call identity", async () => {
    streamModel.mockReturnValue(
      fakeStream([
        { type: "thinking_start", contentIndex: 0 },
        { type: "thinking_delta", contentIndex: 0, delta: "checking" },
        { type: "thinking_end", contentIndex: 0, content: "checking" },
        {
          type: "done",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "checking" },
              { type: "text", text: "done" },
            ],
            stopReason: "endTurn",
            timestamp: Date.now(),
          },
        },
      ]) as any,
    );

    const events = await collectEvents(executeLoop(makeConfig({ tools: [] }), makeMessages("Hi")));
    const context = events.find((event) => event.type === "model_context_prepared");
    const thinking = events.filter((event) => event.type.startsWith("thinking_"));

    expect(thinking.map((event) => event.type)).toEqual([
      "thinking_start",
      "thinking_delta",
      "thinking_end",
    ]);
    expect(thinking).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          modelCallId:
            context?.type === "model_context_prepared" ? context.manifest.modelCallId : undefined,
        }),
      ]),
    );
  });

  it("forwards cache reports without adding them to the conversation", async () => {
    const report = {
      outcome: "success" as const,
      modelCallId: "cache-call",
      scopeId: "cache-scope",
      requestedRetention: "default" as const,
      appliedRetention: "short" as const,
      capability: {
        mode: "automatic_prefix" as const,
        retentions: ["none", "short"] as const,
        supportsStableScopeKey: true,
      },
      lifecycle: "cold" as const,
      commonPrefixMessageCount: 0,
      previousMessageCount: 0,
      currentMessageCount: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 10,
      inputTokens: 90,
      cacheHitRate: 0,
      createdAt: 1,
    };
    streamModel.mockReturnValue(
      fakeStream([
        { type: "cache_report", report },
        {
          type: "done",
          message: { content: [{ type: "text", text: "done" }] },
        },
      ]) as never,
    );

    const events = await collectEvents(executeLoop(makeConfig({ tools: [] }), makeMessages("Hi")));

    expect(events).toContainEqual({ type: "model_cache_report", report });
    const done = events.find((event) => event.type === "done");
    expect(done?.type === "done" ? done.produced : undefined).toHaveLength(1);
  });

  it("yields context compression progress before the prepared context", async () => {
    const delegate = createContextEngine();
    const contextEngine: ContextEnginePort = {
      async prepare(request) {
        request.progress.publish({
          type: "compression_started",
          compressionId: "compression-1",
          modelCallId: request.identity.modelCallId,
          beforeTokens: 100,
          startedKind: "heavy_checkpoint",
          trigger: { inputTokens: 100, usableInputBudget: 110, thresholdTokens: 99 },
        });
        await Promise.resolve();
        request.progress.publish({
          type: "compression_completed",
          compressionId: "compression-1",
          modelCallId: request.identity.modelCallId,
          report: {
            beforeTokens: 100,
            afterTokens: 50,
            tokenDelta: 50,
            reductionRatio: 0.5,
            trigger: { inputTokens: 100, usableInputBudget: 110, thresholdTokens: 99 },
            operations: [{ kind: "heavy_checkpoint", affectedCount: 10, action: "create" }],
            durationMs: 1,
          },
        });
        return delegate.prepare(request);
      },
    };
    streamModel.mockReturnValue(
      fakeStream([
        { type: "done", message: { content: [{ type: "text", text: "done" }] } },
      ]) as never,
    );

    const events = await collectEvents(
      executeLoop(makeConfig({ tools: [] }), makeMessages("Hi"), undefined, [], contextEngine),
    );
    expect(events.slice(0, 3).map((event) => event.type)).toEqual([
      "context_progress",
      "context_progress",
      "model_context_prepared",
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
    if (doneEvent?.type === "done") {
      expect(doneEvent.produced).toHaveLength(1);
      expect(producedMessages(doneEvent.produced)[0]).toMatchObject(assistantMsg);
    }
  });

  it("emits a correlated tool batch around the tool lifecycle", async () => {
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

    const lifecycle = events
      .filter((event) => event.type.startsWith("tool_"))
      .map((event) => event.type);
    expect(lifecycle).toEqual([
      "tool_batch_started",
      "tool_start",
      "tool_end",
      "tool_batch_completed",
    ]);
    const batchStarted = events.find((event) => event.type === "tool_batch_started");
    expect(batchStarted).toMatchObject({
      type: "tool_batch_started",
      batch: {
        members: [
          {
            toolName: "bash",
            toolCallId: "call_1",
            preview: {
              action: "execute",
              resource: { kind: "command", value: "test" },
            },
          },
        ],
      },
    });

    // Verify tool_start and tool_end events
    const toolStart = events.find((e) => e.type === "tool_start");
    expect(toolStart).toBeDefined();
    expect(toolStart).toMatchObject({
      type: "tool_start",
      toolName: "bash",
      toolCallId: "call_1",
      batch: { index: 0, total: 1 },
    });

    const toolEnd = events.find((e) => e.type === "tool_end");
    expect(toolEnd).toBeDefined();
    expect(toolEnd).toMatchObject({
      type: "tool_end",
      toolName: "bash",
      toolCallId: "call_1",
      batch: { index: 0, total: 1 },
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
      expect(producedMessages(doneEvent.produced).map((message) => message.role)).toEqual([
        "assistant",
        "toolResult",
        "assistant",
      ]);
    }
  });

  it("injects a complete environment replacement between model calls and binds tool cwd", async () => {
    const tool = makeTool("bash");
    const config = makeConfig({ tools: [tool] });
    streamModel
      .mockReturnValueOnce(
        fakeStream([
          {
            type: "done",
            message: {
              content: [{ type: "toolCall", id: "call_1", name: "bash", arguments: {} }],
              stopReason: "toolUse",
            },
          },
        ]) as never,
      )
      .mockReturnValueOnce(
        fakeStream([
          {
            type: "done",
            message: { content: [{ type: "text", text: "done" }], stopReason: "endTurn" },
          },
        ]) as never,
      );
    let captures = 0;
    const environmentContext = new EnvironmentContextController({
      async snapshot() {
        captures += 1;
        return {
          workspace: { cwd: "/workspace/project", roots: ["/workspace"] },
          time: {
            currentDate: captures === 1 ? "2026-08-17" : "2026-08-18",
            timezone: captures === 1 ? "Asia/Shanghai" : "America/New_York",
          },
          execution: { platform: "linux", arch: "x64", shell: "zsh", kind: "host" },
        };
      },
    });

    const events = await collectEvents(
      runAgentLoop({
        config,
        snapshot: { sessionId: "test-session", revision: 1, messages: makeMessages("work") },
        contextEngine: createContextEngine(),
        contextMiddleware: [],
        modelRuntime,
        agentId: "test",
        environmentContext,
        toolCallCoordinator: createCoordinator(),
      }),
    );

    expect(tool.execute).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ cwd: "/workspace/project" }),
    );
    const secondContext = streamModel.mock.calls[1]![1];
    const renderedEnvironments = secondContext.messages.filter(
      (message) =>
        message.role === "user" &&
        typeof message.content === "string" &&
        message.content.includes("<environment_context"),
    );
    expect(renderedEnvironments).toHaveLength(1);
    expect(renderedEnvironments[0]).toMatchObject({
      role: "user",
      content: expect.stringContaining("America/New_York"),
    });
    const done = events[events.length - 1];
    expect(done?.type).toBe("done");
    if (done?.type !== "done") throw new Error("Expected done event");
    expect(
      done.produced?.flatMap((record) =>
        record.kind === "environment" ? [record.context.revision] : [],
      ),
    ).toEqual([1, 2]);
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
    expect(secondRequest.messages[1]).toMatchObject({ content: "run" });
    expect(secondRequest.messages[2]).toMatchObject({
      role: "assistant",
      content: [expect.objectContaining({ type: "toolCall", name: "bash" })],
    });
    const done = events.at(-1);
    expect(done?.type).toBe("done");
    if (done?.type === "done") {
      expect(producedMessages(done.produced)[0]).toMatchObject({
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
    expect(snapshots[0].manifest.outputMessageCount).toBe(2);
    expect(snapshots[1].manifest.outputMessageCount).toBe(4);
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
    const done = events.find((event) => event.type === "done");
    expect(
      done?.type === "done"
        ? producedMessages(done.produced).find((message) => message.role === "toolResult")
        : undefined,
    ).toMatchObject({
      details: {
        kind: "skill_read",
        skillName: "frontend-design",
        status: "loaded",
        tokenEstimate: 42,
      },
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
      expect(producedMessages(doneEvent.produced)[1]).toMatchObject({
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
      failure: {
        code: "max_turns_reached",
        message: "Max turns reached (1)",
        retryable: false,
      },
      produced: expect.arrayContaining([
        expect.objectContaining({
          kind: "message",
          message: expect.objectContaining({ role: "assistant", stopReason: "toolUse" }),
        }),
        expect.objectContaining({
          kind: "message",
          message: expect.objectContaining({ role: "toolResult", toolCallId: "call_1" }),
        }),
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
      failure: { code: "tool_loop_detected" },
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
      failure: { code: "tool_loop_detected" },
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
      {
        type: "error",
        failure: {
          code: "model_runtime_error",
          message: "Rate limit exceeded",
          retryable: true,
        },
      },
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
