import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConsolePort, CliHostServices } from "../host-services";

const fixture = vi.hoisted(() => {
  const application = {
    agentId: "coding",
    extensions: { commands: { list: () => [] } },
    currentSessionSnapshot: vi.fn(() => ({ sessionId: "session-1", messages: [] })),
    run: vi.fn(async (_input: string, _callbacks: unknown, _signal?: AbortSignal) => undefined),
    newSession: vi.fn(async () => "session-2"),
    clearSession: vi.fn(async () => undefined),
    refreshInstructions: vi.fn(async () => undefined),
  };
  const instance = {
    id: "coding",
    application,
    capabilities: {},
    dispose: vi.fn(async () => undefined),
  };
  const modelService = {
    resolve: vi.fn(async () => ({ providerId: "provider" })),
    isConfigured: vi.fn(async () => true),
    dispose: vi.fn(async () => undefined),
  };
  return {
    application,
    instance,
    modelService,
    createAgent: vi.fn(async () => instance),
  };
});

vi.mock("@omni-agent/app", () => ({
  AgentFactory: class {
    create = fixture.createAgent;
  },
  ConfigService: class {
    readonly diagnostics = [];
    resolveModelConfiguration = vi.fn(async () => ({
      selection: { vendorId: "vendor", connectionId: "default", modelId: "model" },
      scope: "global",
      kind: "agent",
    }));
  },
  createModelService: vi.fn(async () => fixture.modelService),
  resolveWorkspaceContext: vi.fn(async () => ({ root: "/workspace" })),
}));

vi.mock("../agents/default-agent-package-catalog", () => ({
  createDefaultAgentPackageCatalog: vi.fn(() => ({
    load: vi.fn(async () => ({
      packageName: "@omni-agent/agent-coding",
      packageVersion: "0.0.1",
      manifest: { metadata: { id: "coding" } },
      blueprint: {},
    })),
  })),
}));

vi.mock("../onboarding", () => ({
  persistOnboardingSelection: vi.fn(async () => undefined),
  runOnboarding: vi.fn(async () => {
    throw new Error("onboarding should not run for configured fixture");
  }),
}));

import { runAgentMode } from "./run";

describe("Agent mode conversation lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fixture.createAgent.mockResolvedValue(fixture.instance);
    fixture.instance.dispose.mockResolvedValue(undefined);
    fixture.modelService.dispose.mockResolvedValue(undefined);
    fixture.application.currentSessionSnapshot.mockReturnValue({
      sessionId: "session-1",
      messages: [],
    });
  });

  it("reuses one Agent application and Session across consecutive submitted turns", async () => {
    let resolveHandlers!: () => void;
    const handlersReady = new Promise<void>((resolve) => {
      resolveHandlers = resolve;
    });
    let handlers:
      | {
          onSubmit(input: string): void | Promise<void>;
          onInterrupt(): boolean;
        }
      | undefined;
    const appendUserMessage = vi.fn();
    const createRunPresentation = vi.fn(() => ({
      callbacks: () => ({}),
      cancelPending: vi.fn(),
    }));
    const consoleView = createConsole({
      bindHandlers(value) {
        handlers = value;
        resolveHandlers();
      },
      async start() {
        await handlersReady;
        await handlers?.onSubmit("first turn");
        await handlers?.onSubmit("second turn");
        return { kind: "completed" as const };
      },
      appendUserMessage,
      createRunPresentation,
    });
    const { host, createAgentConsole } = createHost(consoleView);

    await expect(runAgentMode("coding", host)).resolves.toEqual({ kind: "completed" });

    expect(createAgentConsole).toHaveBeenCalledOnce();
    expect(fixture.createAgent).toHaveBeenCalledOnce();
    expect(fixture.application.currentSessionSnapshot).toHaveBeenCalledOnce();
    expect(fixture.application.newSession).not.toHaveBeenCalled();
    expect(fixture.application.run.mock.calls.map(([input]) => input)).toEqual([
      "first turn",
      "second turn",
    ]);
    expect(appendUserMessage.mock.calls.map(([input]) => input)).toEqual([
      "first turn",
      "second turn",
    ]);
    expect(createRunPresentation).toHaveBeenCalledTimes(2);
    expect(consoleView.dispose).toHaveBeenCalledOnce();
    expect(fixture.instance.dispose).toHaveBeenCalledOnce();
    expect(fixture.modelService.dispose).toHaveBeenCalledOnce();
  });

  it("preserves the operation error when conversation cleanup also fails", async () => {
    const operationError = new Error("console failed");
    const cleanupError = new Error("instance cleanup failed");
    fixture.instance.dispose.mockRejectedValueOnce(cleanupError);
    const consoleView = createConsole({
      start: vi.fn().mockRejectedValue(operationError),
    });
    const { host } = createHost(consoleView);

    const failure = await runAgentMode("coding", host).catch((error) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({
      operationError,
      cleanupFailures: [{ resource: "agent_instance", error: cleanupError }],
      cause: operationError,
    });
    expect(consoleView.dispose).toHaveBeenCalledOnce();
    expect(fixture.modelService.dispose).toHaveBeenCalledOnce();
  });

  it("rethrows the original operation error when cleanup succeeds", async () => {
    const operationError = new Error("console failed");
    const consoleView = createConsole({
      start: vi.fn().mockRejectedValue(operationError),
    });
    const { host } = createHost(consoleView);

    await expect(runAgentMode("coding", host)).rejects.toBe(operationError);
    expect(fixture.instance.dispose).toHaveBeenCalledOnce();
    expect(consoleView.dispose).toHaveBeenCalledOnce();
    expect(fixture.modelService.dispose).toHaveBeenCalledOnce();
  });

  it("retains nested conversation failures when ModelService cleanup also fails", async () => {
    const operationError = new Error("console failed");
    const instanceCleanupError = new Error("instance cleanup failed");
    const modelCleanupError = new Error("model cleanup failed");
    fixture.instance.dispose.mockRejectedValueOnce(instanceCleanupError);
    fixture.modelService.dispose.mockRejectedValueOnce(modelCleanupError);
    const consoleView = createConsole({
      start: vi.fn().mockRejectedValue(operationError),
    });
    const { host } = createHost(consoleView);

    const failure = await runAgentMode("coding", host).catch((error) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({
      cleanupFailures: [{ resource: "model_service", error: modelCleanupError }],
      operationError: {
        operationError,
        cleanupFailures: [{ resource: "agent_instance", error: instanceCleanupError }],
        cause: operationError,
      },
    });
  });
});

function createConsole(overrides: Partial<AgentConsolePort>): AgentConsolePort {
  return {
    interactionSurface: { request: vi.fn() },
    accessConsentBroker: { request: vi.fn() },
    commandInteraction: {
      pause: vi.fn(),
      resume: vi.fn(),
      select: vi.fn(),
      line: vi.fn(),
      spacer: vi.fn(),
    },
    bindHandlers: vi.fn(),
    start: vi.fn(async () => ({ kind: "completed" as const })),
    terminate: vi.fn(),
    dispose: vi.fn(),
    setCommandCatalog: vi.fn(),
    showWelcome: vi.fn(),
    showSessionHistory: vi.fn(),
    clearSessionHistory: vi.fn(),
    appendUserMessage: vi.fn(),
    writeNotice: vi.fn(),
    setStatus: vi.fn(),
    setActivity: vi.fn(),
    presentSkillRead: vi.fn(),
    createRunPresentation: vi.fn(() => ({
      callbacks: () => ({}),
      cancelPending: vi.fn(),
    })),
    ...overrides,
  };
}

function createHost(consoleView: AgentConsolePort): {
  host: CliHostServices;
  createAgentConsole: ReturnType<typeof vi.fn>;
} {
  const createAgentConsole = vi.fn((_options: { workspaceRoot: string }) => consoleView);
  return {
    createAgentConsole,
    host: {
      runtime: {
        cwd: "/workspace",
        cliEntry: import.meta.filename,
        globalDirectory: "/global",
        agentPackagesDirectory: "/agents",
        nodeVersion: "22.19.0",
      },
      output: { stdout: vi.fn(), stderr: vi.fn() },
      processRouter: { run: vi.fn() },
      processPlanner: { prepare: vi.fn() },
      hostRuntime: { platform: "linux", home: "/home/test" },
      networkRuntime: { open: vi.fn() },
      createAgentConsole,
      createOnboardingInteraction: vi.fn(),
      runTracePreview: vi.fn(),
      confirm: vi.fn(),
      text: {
        heading: String,
        accent: String,
        muted: String,
        success: String,
        warning: String,
        error: String,
      },
    },
  };
}
