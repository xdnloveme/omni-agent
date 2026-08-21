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

vi.mock("../agents/agent-blueprint-loader", () => ({
  loadAgentBlueprint: vi.fn(async () => ({ id: "coding" })),
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
    fixture.application.currentSessionSnapshot.mockReturnValue({
      sessionId: "session-1",
      messages: [],
    });
  });

  it("reuses one Agent application and Session across consecutive submitted turns", async () => {
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
    const consoleView = {
      interactionSurface: { request: vi.fn() },
      approvalBroker: { request: vi.fn() },
      commandInteraction: {
        pause: vi.fn(),
        resume: vi.fn(),
        select: vi.fn(),
        line: vi.fn(),
        spacer: vi.fn(),
      },
      bindHandlers(value) {
        handlers = value;
      },
      async start() {
        await handlers?.onSubmit("first turn");
        await handlers?.onSubmit("second turn");
        return { kind: "completed" as const };
      },
      terminate: vi.fn(),
      dispose: vi.fn(),
      setCommandCatalog: vi.fn(),
      showWelcome: vi.fn(),
      showSessionHistory: vi.fn(),
      clearSessionHistory: vi.fn(),
      appendUserMessage,
      writeNotice: vi.fn(),
      setStatus: vi.fn(),
      setActivity: vi.fn(),
      presentSkillRead: vi.fn(),
      createRunPresentation,
    } satisfies AgentConsolePort;
    const createAgentConsole = vi.fn((_options: { workspaceRoot: string }) => consoleView);
    const host = {
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
    } satisfies CliHostServices;

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
});
