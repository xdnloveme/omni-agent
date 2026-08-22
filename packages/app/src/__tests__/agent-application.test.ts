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
  ToolAuthorizationRouter,
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
import { createPermissionRuntime } from "../permissions/create-permission-runtime";
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
  const permissions = createPermissionRuntime({
    globalDirectory: root,
  });
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
      permissionService: permissions.service,
      toolCallCoordinator: new ToolCallCoordinator({
        authorizer: new ToolAuthorizationRouter(permissions.permissionGate, inputValidator),
        invocationRunner: new ToolInvocationRunner(),
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
