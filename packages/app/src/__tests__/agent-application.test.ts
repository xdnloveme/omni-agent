import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentSessionRepository,
  ApproximateContextTokenEstimator,
  ContextPolicyPipeline,
  DefaultContextEngine,
  EnvironmentContextController,
  ToolAccessController,
  ToolCallCoordinator,
  ToolInputValidator,
  ToolInvocationRunner,
  type AgentConfig,
  type TranscriptMessage,
  type ModelRuntimePort,
} from "@omni-agent/core";
import { AgentApplication, AgentApplicationDisposalError } from "../application/agent-application";
import type { ConfigService } from "../config/config-service";
import type { ExtensionManager } from "../extensions/extension-manager";
import type { ModelService } from "../models/model-service";
import type { ModelCacheLeaseController } from "../models/cache/model-cache-lease-controller";
import { ExecutionSettingsRepository, ExecutionSettingsService } from "../execution-settings";
import { AgentScopedTraceRuntime } from "../tracing/agent-scoped-trace-runtime";
import { TraceQueryService } from "../tracing/trace-query-service";
import { AgentAssemblyEvidence } from "../assembly/agent-assembly-evidence";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(withTrace = false) {
  const root = await mkdtemp(join(tmpdir(), "omni-agent-app-"));
  directories.push(root);
  const sessions = new AgentSessionRepository({ agentId: "test", sessionsRoot: root });
  await sessions.restoreLatestOrCreate();
  const runtime: ModelRuntimePort = { async *stream() {} };
  const selection = { vendorId: "test", connectionId: "default", modelId: "model" };
  const resolve = vi.fn<ModelService["resolve"]>(async (next) => ({
    ...next,
    providerId: next.vendorId,
    contextWindow: 2_000,
    modelMaxOutputTokens: 200,
    requestedOutputTokens: 200,
  }));
  const isConfigured = vi.fn<ModelService["isConfigured"]>(async () => ({ type: "api_key" }));
  const modelService = { runtime, resolve, isConfigured } as unknown as ModelService;
  const configService = {
    saveAgentModel: vi.fn(async () => undefined),
    saveSharedModel: vi.fn(async () => undefined),
    removeAgentModel: vi.fn(async () => undefined),
    resolveModel: vi.fn(async () => selection),
    resolveModelConfiguration: vi.fn(async () => ({
      selection,
      scope: "global" as const,
      kind: "shared" as const,
    })),
    resolveSharedModel: vi.fn(async () => selection),
  } as unknown as ConfigService;
  const dispose = vi.fn(async () => undefined);
  const extensions = { dispose, agents: { get: vi.fn() } } as unknown as ExtensionManager;
  const config: AgentConfig = {
    model: {
      ...selection,
      providerId: "test",
      contextWindow: 1_000,
      modelMaxOutputTokens: 100,
      requestedOutputTokens: 100,
    },
    systemPrompt: "test",
    tools: [],
  };
  const executionSettings = new ExecutionSettingsService(new ExecutionSettingsRepository(root));
  const contextStorage = { clear: vi.fn(async () => undefined) };
  const cacheLeases = {
    hydrate: vi.fn(async () => undefined),
    persist: vi.fn(async () => undefined),
    forget: vi.fn(),
  } as unknown as ModelCacheLeaseController;
  let currentDate = "2026-08-17";
  const assemblyEvidence = new AgentAssemblyEvidence({
    agentId: "test",
    packageName: "@omni-agent/agent-test",
    packageVersion: "1.0.0",
    manifestApiVersion: "omni-agent/v2",
    blueprintApiVersion: 2,
    workspaceId: "workspace",
    model: selection,
    extensions: [],
    composition: {
      promptProfileId: "test.default",
      promptContributorIds: [],
      toolComponentIds: [],
      capabilityIds: [],
    },
    toolNames: [],
    systemPromptDigest: "prompt",
  });
  const traceRuntime = withTrace
    ? new AgentScopedTraceRuntime({
        globalDirectory: root,
        agentId: "test",
        workspaceId: "workspace",
        cwd: root,
        assembly: () => assemblyEvidence.snapshot(),
      })
    : undefined;
  const inputValidator = new ToolInputValidator();
  return {
    app: new AgentApplication({
      extensions,
      sessions,
      agentConfig: config,
      agentId: "test",
      cwd: root,
      modelService,
      modelSelection: selection,
      configService,
      executionSettings,
      workspaceId: "workspace",
      toolCallCoordinator: new ToolCallCoordinator({
        accessController: new ToolAccessController({
          settings: executionSettings,
          consent: {
            async request() {
              return "deny";
            },
          },
        }),
        processPlanner: {
          async prepare() {
            throw new Error("unexpected process tool");
          },
        },
        hostRuntime: { platform: "linux", home: root },
        invocationRunner: new ToolInvocationRunner({
          processRouter: {
            async run() {
              throw new Error("unexpected process tool");
            },
          },
        }),
        inputValidator,
      }),
      contextEngine: new DefaultContextEngine(
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
      ),
      contextMiddleware: [],
      contextStorage,
      environmentContext: new EnvironmentContextController({
        async snapshot() {
          return {
            workspace: { cwd: root, roots: [root] },
            time: { currentDate, timezone: "UTC" },
            execution: { platform: "linux", arch: "x64", shell: "sh", kind: "host" },
          };
        },
      }),
      cacheLeases,
      runObservation: traceRuntime,
      assemblyEvidence,
    }),
    configService,
    extensions,
    dispose,
    isConfigured,
    sessions,
    contextStorage,
    cacheLeases,
    traceRuntime,
    runtime,
    assemblyEvidence,
    setCurrentDate(value: string) {
      currentDate = value;
    },
  };
}

describe("AgentApplication model selection", () => {
  it("persists an Agent override before activating it", async () => {
    const { app, configService, assemblyEvidence } = await fixture();
    const next = { vendorId: "next", connectionId: "regional", modelId: "next-model" };
    vi.mocked(configService.resolveModel).mockResolvedValueOnce(next);

    await app.setAgentModel(next);

    expect(configService.saveAgentModel).toHaveBeenCalledWith("test", next, {
      scope: "global",
    });
    expect(app.modelSelection).toEqual(next);
    expect(assemblyEvidence.snapshot().model).toEqual(next);
  });

  it("keeps the current model when authentication fails", async () => {
    const { app, configService, isConfigured } = await fixture();
    isConfigured.mockResolvedValueOnce(undefined);
    const previous = app.modelSelection;

    await expect(
      app.setAgentModel({ vendorId: "next", connectionId: "default", modelId: "next" }),
    ).rejects.toThrow("Provider is not configured");

    expect(configService.saveAgentModel).not.toHaveBeenCalled();
    expect(app.modelSelection).toBe(previous);
  });

  it("removes only the global Agent override before activating the shared model", async () => {
    const { app, configService } = await fixture();

    await app.useSharedModel();

    expect(configService.removeAgentModel).toHaveBeenCalledWith("test", { scope: "global" });
    expect(app.modelSelection).toEqual({
      vendorId: "test",
      connectionId: "default",
      modelId: "model",
    });
  });

  it("does not remove a project-level Agent override", async () => {
    const { app, configService } = await fixture();
    vi.mocked(configService.resolveModelConfiguration).mockResolvedValueOnce({
      selection: { vendorId: "project", connectionId: "default", modelId: "project-model" },
      scope: "project",
      kind: "agent",
    });

    await expect(app.useSharedModel()).rejects.toThrow("Cannot remove the project-level override");
    expect(configService.removeAgentModel).not.toHaveBeenCalled();
  });

  it("projects exhausted output recovery as a failed run and keeps recovery out of user history", async () => {
    const { app, runtime, traceRuntime, sessions } = await fixture(true);
    traceRuntime!.control.start();
    let calls = 0;
    runtime.stream = async function* () {
      calls++;
      yield {
        type: "done",
        message: {
          role: "assistant",
          api: "test",
          provider: "test",
          model: "model",
          content: [{ type: "text", text: "partial" }],
          stopReason: "length",
          usage: { input: 5, output: 10, cacheRead: 0, cacheWrite: 0 },
          timestamp: Date.now(),
        },
      };
    };
    await app.run("finish", {});
    expect(calls).toBe(4);
    const query = new TraceQueryService(traceRuntime!.store);
    const [session] = await query.sessions();
    const [run] = await query.runs(session!.sessionId);
    expect(run).toMatchObject({ status: "error" });
    const replay = await query.replay(run!.sessionId, run!.runId);
    const requests = replay.filter((event) => event.kind === "model.request.captured");
    expect(requests[1]?.payload).toMatchObject({
      recovery: { attempt: 1, parentModelCallId: expect.any(String) },
    });
    expect(requests[3]?.payload).toMatchObject({
      recovery: { attempt: 3 },
      manifest: { outputBudget: { policyVersion: 1 } },
    });
    expect(replay.at(-1)?.kind).toBe("run.failed");
    expect(sessions.snapshot().messages.filter((message) => message.role === "user")).toHaveLength(
      1,
    );
    await app.dispose();
  });

  it("disposes extensions idempotently through its owning instance", async () => {
    const { app, dispose } = await fixture();
    await app.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("refuses partial disposal while a run is active and closes after settlement", async () => {
    const { app, runtime, dispose } = await fixture();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => (entered = resolve));
    const blocked = new Promise<void>((resolve) => (release = resolve));
    runtime.stream = async function* () {
      entered();
      await blocked;
      yield {
        type: "done",
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
        stopReason: "end_turn",
      } as never;
    };

    const running = app.run("hello", {});
    await started;
    await expect(app.dispose()).rejects.toMatchObject({ code: "agent_application_busy" });
    expect(dispose).not.toHaveBeenCalled();
    release();
    await running;
    await app.dispose();
    await expect(app.run("later", {})).rejects.toMatchObject({
      code: "agent_application_closed",
    });
  });

  it("owns its run and Session mutation concurrency invariant", async () => {
    const { app, runtime, sessions } = await fixture();
    const initialSessionId = sessions.currentId!;
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => (entered = resolve));
    const blocked = new Promise<void>((resolve) => (release = resolve));
    runtime.stream = async function* () {
      entered();
      await blocked;
      yield { type: "done" } as never;
    };

    const running = app.run("first", {});
    await started;
    await expect(app.run("second", {})).rejects.toMatchObject({
      code: "agent_application_busy",
    });
    await expect(app.openSession(initialSessionId)).rejects.toMatchObject({
      code: "agent_application_busy",
    });
    await expect(app.newSession()).rejects.toMatchObject({ code: "agent_application_busy" });
    await expect(app.clearSession()).rejects.toMatchObject({ code: "agent_application_busy" });

    release();
    await running;
    const nextSessionId = await app.newSession();
    await expect(app.openSession(initialSessionId)).resolves.toMatchObject({
      sessionId: initialSessionId,
    });
    expect(nextSessionId).not.toBe(initialSessionId);
  });
});

describe("AgentApplication assembly evidence", () => {
  it("refreshes the effective prompt evidence with the Agent configuration", async () => {
    const { app, extensions, assemblyEvidence } = await fixture();
    vi.mocked(extensions.agents.get).mockReturnValue({
      definition: { id: "test", description: "test", instructions: "refreshed prompt" },
      tools: { include: [] },
    });
    const previousDigest = assemblyEvidence.snapshot().digest;

    await app.refreshInstructions();

    expect(app.agentConfig.systemPrompt).toBe("refreshed prompt");
    expect(assemblyEvidence.snapshot().digest).not.toBe(previousDigest);
  });
});

describe("AgentApplication disposal", () => {
  it("identifies every resource that failed to dispose", async () => {
    const { app, dispose } = await fixture();
    dispose.mockRejectedValueOnce(new Error("extension cleanup failed"));

    const failure = await app.dispose().catch((error) => error);

    expect(failure).toBeInstanceOf(AgentApplicationDisposalError);
    expect(failure).toMatchObject({
      code: "agent_application_disposal_failed",
      failures: [{ resource: "extensions" }],
    });
    await expect(app.dispose()).resolves.toBeUndefined();
    expect(dispose).toHaveBeenCalledOnce();
  });
});

describe("AgentApplication session persistence", () => {
  it("records one complete local run without changing Session persistence", async () => {
    const { app, configService, traceRuntime, sessions, runtime } = await fixture(true);
    traceRuntime!.control.start();
    const nextModel = { vendorId: "next", connectionId: "regional", modelId: "next-model" };
    vi.mocked(configService.resolveModel).mockResolvedValueOnce(nextModel);
    await app.setAgentModel(nextModel);
    runtime.stream = async function* () {
      yield { type: "text_delta", delta: "hello" };
      yield {
        type: "done",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hello" }],
          stopReason: "stop",
          usage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0 },
          timestamp: Date.now(),
        },
      } as never;
    };
    await app.run("trace me", {});

    expect(sessions.snapshot().messages).toHaveLength(2);
    const query = new TraceQueryService(traceRuntime!.store);
    const [session] = await query.sessions();
    const [run] = await query.runs(session!.sessionId);
    expect(run).toMatchObject({ status: "completed", sessionId: sessions.snapshot().sessionId });
    expect(run?.assembly).toMatchObject({
      packageName: "@omni-agent/agent-test",
      toolNames: [],
      model: nextModel,
    });
    const spans = await query.spans(run!.sessionId, run!.runId);
    expect(spans.map((span) => span.name)).toEqual([
      "agent.run",
      "agent.environment.capture",
      "agent.session.append_input",
      "agent.turn",
      "agent.environment.capture",
      "agent.context.prepare",
      "gen_ai.generate",
      "agent.session.persist_output",
      "agent.finish",
    ]);
    expect(spans.find((span) => span.name === "gen_ai.generate")?.attributes).toMatchObject({
      "gen_ai.usage.input_tokens": expect.any(Number),
      "gen_ai.usage.output_tokens": 1,
    });
    const replay = await query.replay(run!.sessionId, run!.runId);
    expect(replay.map((event) => event.kind)).toEqual([
      "run.started",
      "user.input",
      "turn.started",
      "context.prepared",
      "model.request.captured",
      "model.started",
      "model.text.delta",
      "model.completed",
      "agent.final_response",
      "turn.completed",
      "run.completed",
    ]);
    expect(replay.find((event) => event.kind === "turn.completed")?.payload).toMatchObject({
      usage: { inputTokens: expect.any(Number), outputTokens: 1, totalTokens: expect.any(Number) },
    });
    expect(replay.find((event) => event.kind === "run.completed")?.payload).toMatchObject({
      usage: { inputTokens: expect.any(Number), outputTokens: 1, totalTokens: expect.any(Number) },
    });
    expect(run?.summary).toMatchObject({
      usage: { inputTokens: expect.any(Number), outputTokens: 1, totalTokens: expect.any(Number) },
    });
  });

  it("writes one initial environment snapshot, skips identical snapshots, and replaces on change", async () => {
    const { app, sessions, setCurrentDate } = await fixture();
    vi.spyOn(app.runner, "run").mockImplementation(() =>
      (async function* () {
        yield { type: "done" as const };
      })(),
    );

    await app.run("first", {});
    await app.run("second", {});
    expect(sessions.snapshot().environment).toMatchObject({ revision: 1 });
    expect(sessions.snapshot().messages).toHaveLength(2);

    setCurrentDate("2026-08-18");
    await app.run("third", {});
    expect(sessions.snapshot().environment).toMatchObject({ revision: 2 });
    expect(sessions.snapshot().messages).toHaveLength(3);
  });

  it("reports an initial environment failure without persisting the user message", async () => {
    const { app, sessions, setCurrentDate } = await fixture();
    setCurrentDate("invalid");
    const onError = vi.fn();

    await app.run("must not persist", { onError });

    expect(onError).toHaveBeenCalledWith({
      code: "environment_context_invalid",
      message: "Current date must be a valid YYYY-MM-DD calendar date.",
      field: "time.currentDate",
      retryable: false,
    });
    expect(sessions.snapshot()).toMatchObject({ messages: [] });
  });

  it("clears Session transcript and Context sidecar through separate owners", async () => {
    const { app, sessions, contextStorage, cacheLeases } = await fixture();
    const sessionId = sessions.currentId!;
    await sessions.append(sessionId, [
      {
        kind: "message",
        message: { role: "user", content: "remove me", timestamp: Date.now() },
      },
    ]);

    await app.clearSession();

    expect(sessions.snapshot().messages).toEqual([]);
    expect(contextStorage.clear).toHaveBeenCalledWith(sessionId);
    expect(cacheLeases.forget).toHaveBeenCalledWith(sessionId);
  });

  it("persists produced messages when the turn limit is reached", async () => {
    const { app, sessions } = await fixture();
    const producedMessages: TranscriptMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_1",
            name: "test_tool",
            arguments: {},
          },
        ],
        api: "test",
        provider: "test",
        model: "test-model",
        stopReason: "toolUse",
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
        timestamp: Date.now(),
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "test_tool",
        content: [{ type: "text", text: "tool result" }],
        isError: false,
        timestamp: Date.now(),
      },
    ];
    const produced = producedMessages.map((message) => ({ kind: "message" as const, message }));

    vi.spyOn(app.runner, "run").mockReturnValue(
      (async function* () {
        yield {
          type: "error" as const,
          failure: {
            code: "max_turns_reached",
            message: "Max turns reached (30)",
            retryable: false,
          },
          produced,
          turnCount: 30,
          maxTurns: 30,
        };
      })(),
    );

    await app.run("keep working", {});

    expect(sessions.snapshot().messages).toHaveLength(3);
    expect(sessions.snapshot().messages.slice(1)).toEqual(producedMessages);
  });
});

describe("AgentApplication explicit deadlines", () => {
  it("rejects invalid deadlines and cancels expired work without invoking the model or appending input", async () => {
    const { app, runtime, sessions } = await fixture();
    const stream = vi.fn(runtime.stream);
    runtime.stream = stream;
    const before = sessions.snapshot().messages.length;
    await expect(app.run("invalid", {}, undefined, { deadlineAtMs: NaN })).rejects.toThrow(
      "safe integer",
    );
    await expect(
      app.run("expired", {}, undefined, { deadlineAtMs: Date.now() - 1 }),
    ).rejects.toMatchObject({ name: "AbortError", code: "run_deadline_exceeded" });
    expect(stream).not.toHaveBeenCalled();
    expect(sessions.snapshot().messages).toHaveLength(before);
    await app.dispose();
  });

  it("cancels one Run, retains ownership until late model settlement, and does not publish late success", async () => {
    const { app, runtime, sessions, traceRuntime } = await fixture(true);
    traceRuntime!.control.start();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    let aborted!: () => void;
    const cancelled = new Promise<void>((resolve) => {
      aborted = resolve;
    });
    let captured = "";
    runtime.stream = async function* (_selection, request, options) {
      captured = JSON.stringify(request.messages);
      options.signal!.addEventListener("abort", aborted, { once: true });
      began();
      await held;
      yield { type: "text_delta", delta: "late" };
    };
    const onTextChunk = vi.fn();
    const onDone = vi.fn();
    const run = app.run("deadline", { onTextChunk, onDone }, undefined, {
      deadlineAtMs: Date.now() + 300,
    });
    const outcome = run.catch((error) => error);
    await started;
    await cancelled;
    // Retain ownership even after the supervisor's bounded cleanup grace expires.
    await new Promise((resolve) => setTimeout(resolve, 2100));
    expect(captured).toContain("<run_context>");
    expect(captured).toContain("remainingMs");
    await expect(app.run("overlap", {})).rejects.toMatchObject({ code: "agent_application_busy" });
    await expect(app.dispose()).rejects.toMatchObject({ code: "agent_application_busy" });
    release();
    expect(await outcome).toMatchObject({ name: "AbortError", code: "run_deadline_exceeded" });
    expect(onTextChunk).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
    expect(JSON.stringify(sessions.snapshot())).not.toContain("<run_context>");
    const query = new TraceQueryService(traceRuntime!.store);
    const [session] = await query.sessions();
    const [trace] = await query.runs(session!.sessionId);
    expect(trace?.status).toBe("cancelled");
    const replay = await query.replay(trace!.sessionId, trace!.runId);
    expect(replay.filter((e) => e.kind === "run.cancelled")).toHaveLength(1);
    expect(replay.find((e) => e.kind === "run.cancelled")?.payload).toMatchObject({
      failure: { code: "run_deadline_exceeded" },
    });
    await app.dispose();
  });
});

it("does not publish completion when cancellation happens during output persistence", async () => {
  const { app, sessions, runtime } = await fixture();
  const controller = new AbortController();
  const append = sessions.append.bind(sessions);
  vi.spyOn(sessions, "append").mockImplementation(async (id, entries) => {
    if (entries.some((entry) => entry.kind === "message" && entry.message.role === "assistant"))
      controller.abort();
    return append(id, entries);
  });
  runtime.stream = async function* () {
    yield {
      type: "done",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        stopReason: "stop",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        timestamp: Date.now(),
      },
    } as never;
  };
  const onDone = vi.fn();
  await expect(app.run("persist", { onDone }, controller.signal)).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(onDone).not.toHaveBeenCalled();
  await app.dispose();
});
