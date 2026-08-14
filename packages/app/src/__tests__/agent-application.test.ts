import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentSessionRepository,
  ApproximateContextTokenEstimator,
  ContextPolicyPipeline,
  DefaultContextEngine,
  ToolAuthorizationRouter,
  ToolCallCoordinator,
  ToolInputValidator,
  ToolInvocationRunner,
  type AgentConfig,
  type TranscriptMessage,
  type ModelRuntimePort,
} from "@omni-agent/core";
import { AgentApplication } from "../application/agent-application";
import type { ConfigService } from "../config/config-service";
import type { ExtensionManager } from "../extensions/extension-manager";
import type { ModelService } from "../models/model-service";
import { createPermissionRuntime } from "../permissions/create-permission-runtime";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
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
    clearAgentModelOverrides: vi.fn(async () => undefined),
    resolveModel: vi.fn(async () => selection),
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
        authorizer: new ToolAuthorizationRouter(permissions.permissionGate),
        invocationRunner: new ToolInvocationRunner(),
        inputValidator: new ToolInputValidator(),
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
    }),
    configService,
    dispose,
    isConfigured,
    sessions,
    contextStorage,
  };
}

describe("AgentApplication model selection", () => {
  it("persists an Agent override before activating it", async () => {
    const { app, configService } = await fixture();
    const next = { vendorId: "next", connectionId: "regional", modelId: "next-model" };

    await app.setAgentModel(next);

    expect(configService.saveAgentModel).toHaveBeenCalledWith("test", next);
    expect(app.modelSelection).toEqual(next);
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

  it("removes an Agent override before activating the shared model", async () => {
    const { app, configService } = await fixture();

    await app.useSharedModel();

    expect(configService.clearAgentModelOverrides).toHaveBeenCalledWith("test");
    expect(app.modelSelection).toEqual({
      vendorId: "test",
      connectionId: "default",
      modelId: "model",
    });
  });

  it("disposes extensions idempotently through its owning instance", async () => {
    const { app, dispose } = await fixture();
    await app.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });
});

describe("AgentApplication session persistence", () => {
  it("clears Session transcript and Context sidecar through separate owners", async () => {
    const { app, sessions, contextStorage } = await fixture();
    const sessionId = sessions.currentId!;
    await sessions.append(sessionId, [
      { role: "user", content: "remove me", timestamp: Date.now() },
    ]);

    await app.clearSession();

    expect(sessions.snapshot().messages).toEqual([]);
    expect(contextStorage.clear).toHaveBeenCalledWith(sessionId);
  });

  it("persists produced messages when the turn limit is reached", async () => {
    const { app, sessions } = await fixture();
    const produced: TranscriptMessage[] = [
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

    vi.spyOn(app.runner, "run").mockReturnValue(
      (async function* () {
        yield {
          type: "error" as const,
          error: "Max turns reached (30)",
          code: "max_turns_reached" as const,
          produced,
          turnCount: 30,
          maxTurns: 30,
        };
      })(),
    );

    await app.run("keep working", {});

    expect(sessions.snapshot().messages).toHaveLength(3);
    expect(sessions.snapshot().messages.slice(1)).toEqual(produced);
  });
});
