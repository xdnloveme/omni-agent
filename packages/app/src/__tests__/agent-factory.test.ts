import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defineAgent,
  RejectingInteractionSurface,
  type ContextPolicyStagePort,
  type InteractionSurfacePort,
  type ModelRuntimePort,
} from "@omni-agent/core";
import { AgentFactory } from "../application/agent-factory";
import { AgentService } from "../application/agent-service/agent-service";
import type { AgentServiceEvent } from "../application/agent-service/contracts";
import { AgentAssemblyError, AssemblyRollbackError } from "../assembly/errors";
import type {
  AgentBlueprint,
  AgentCapabilities,
  AgentManifest,
  ExtensionSourceLoader,
  LoadedAgentPackage,
} from "../assembly/contracts";
import type { ConfigService } from "../config/config-service";
import type { AgentExtension } from "../extensions/types";
import type { ModelService } from "../models/model-service";
import { createWorkspaceId } from "../workspaces/index";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function agentPackage(
  id = "test",
  options: {
    contributionId?: string;
    prompt?: string;
    capabilities?: AgentCapabilities;
    dispose?: () => void | Promise<void>;
    extensionDispose?: () => void | Promise<void>;
    tools?: string[] | "*";
  } = {},
): LoadedAgentPackage {
  const manifest: AgentManifest = {
    apiVersion: "omni-agent/v2",
    kind: "Agent",
    metadata: { id, displayName: id },
    runtime: { blueprintApiVersion: 2 },
    description: id,
    composition: {
      prompt: { profile: "test.default", contributors: [] },
      tools: { sequence: [] },
      capabilities: {
        ...(options.capabilities?.skills ? { skills: "test.skills" } : {}),
        ...(options.capabilities?.context?.artifactRecovery
          ? { context: { artifactRecovery: "test.artifact-recovery" } }
          : {}),
      },
    },
  };
  const blueprint: AgentBlueprint = {
    descriptor: {
      promptProfiles: [
        { id: "test.default", displayName: "Test prompt", description: "Test prompt" },
      ],
      promptContributors: [],
      toolBundles: [],
      tools: [],
      capabilities: {
        skills: options.capabilities?.skills
          ? [{ id: "test.skills", displayName: "Test skills", description: "Test skills" }]
          : [],
        artifactRecovery: options.capabilities?.context?.artifactRecovery
          ? [
              {
                id: "test.artifact-recovery",
                displayName: "Test artifact recovery",
                description: "Test artifact recovery",
              },
            ]
          : [],
      },
    },
    build: () => ({
      capabilities: options.capabilities ?? {},
      dispose: options.dispose,
      extension: {
        manifest: { id, version: "1.0.0", apiVersion: 1 },
        contributions: {
          agents: [
            {
              definition: defineAgent({
                id: options.contributionId ?? id,
                description: id,
                instructions: options.prompt ?? "prompt",
              }),
              tools: { include: options.tools ?? [] },
            },
          ],
        },
        dispose: options.extensionDispose,
      },
    }),
  };
  return {
    packageName: `@omni-agent/agent-${id}`,
    packageVersion: "1.0.0",
    manifest,
    blueprint,
  };
}

async function factory(
  options: {
    workspaceRoot?: string;
    globalDirectory?: string;
    interactionSurface?: InteractionSurfacePort;
    extensionSourceLoader?: ExtensionSourceLoader;
    workspaceId?: string;
    runtime?: ModelRuntimePort;
  } = {},
) {
  const workspaceRoot =
    options.workspaceRoot ?? (await mkdtemp(join(tmpdir(), "omni-agent-factory-workspace-")));
  const globalDirectory =
    options.globalDirectory ?? (await mkdtemp(join(tmpdir(), "omni-agent-factory-global-")));
  if (!options.workspaceRoot) directories.push(workspaceRoot);
  if (!options.globalDirectory) directories.push(globalDirectory);
  const selection = { vendorId: "test", connectionId: "default", modelId: "model" };
  const runtime: ModelRuntimePort = options.runtime ?? { async *stream() {} };
  const modelService = {
    runtime,
    providerPlugins: undefined,
    resolve: vi.fn(async () => ({
      ...selection,
      providerId: "test",
      contextWindow: 10_000,
      modelMaxOutputTokens: 1_000,
      requestedOutputTokens: 1_000,
    })),
    isConfigured: vi.fn(async () => ({ type: "api_key" as const })),
  } as unknown as ModelService;
  const configService = {
    resolveMcpServers: vi.fn(async () => ({ servers: [], diagnostics: [] })),
    resolveModel: vi.fn(async () => selection),
  } as unknown as ConfigService;
  return new AgentFactory({
    workspace: { id: options.workspaceId ?? createWorkspaceId(workspaceRoot), root: workspaceRoot },
    globalDirectory,
    modelService,
    configService,
    host: {
      interactionSurface: options.interactionSurface ?? new RejectingInteractionSurface(),
      accessConsentBroker: {
        async request() {
          return "deny";
        },
      },
      processRouter: {
        async run() {
          throw new Error("unexpected process tool");
        },
      },
      processPlanner: {
        async prepare() {
          throw new Error("unexpected process tool");
        },
      },
      hostRuntime: { platform: "linux", home: globalDirectory },
      networkRuntime: { open: vi.fn() },
      reservedCommandNames: [],
    },
    extensionSourceLoader: options.extensionSourceLoader,
  });
}

function portableExtension(): AgentExtension {
  return {
    manifest: { id: "portable", version: "1.0.0", apiVersion: 1 },
    contributions: {
      tools: [
        {
          name: "portable_tool",
          description: "portable",
          schema: { type: "object" },
          access: { kind: "internal" },
          execution: { kind: "in_process" },
          timeout: { kind: "none" },
          async execute() {
            return { content: [{ type: "text" as const, text: "ok" }], isError: false };
          },
        },
      ],
    },
  };
}

describe("AgentFactory", () => {
  it("lends the configured interaction surface to the blueprint", async () => {
    const interaction: InteractionSurfacePort = {
      async request(request) {
        return { requestId: request.requestId, kind: "dismissed", values: {} };
      },
    };
    let received: InteractionSurfacePort | undefined;
    const target = agentPackage();
    const build = target.blueprint.build;
    target.blueprint.build = async (context) => {
      received = context.interaction;
      return build(context);
    };
    const instance = await (await factory({ interactionSurface: interaction })).create(target);
    expect(received).toBe(interaction);
    await instance.dispose();
  });

  it("creates a complete Agent instance and reuses its persisted Session", async () => {
    const assemblyFactory = await factory();
    const first = await assemblyFactory.create(agentPackage());
    const firstSessionId = first.application.sessions.currentId;
    await first.dispose();

    const second = await assemblyFactory.create(agentPackage());
    expect(second.application.agentConfig.systemPrompt).toBe("prompt");
    expect(second.application.sessions.currentId).toBe(firstSessionId);
    await second.dispose();
  });

  it("runs a fully assembled AgentApplication through the AgentService boundary", async () => {
    const target = agentPackage();
    const runtime: ModelRuntimePort = {
      async *stream() {
        yield { type: "text_delta", delta: "hello" };
        yield {
          type: "done",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "hello" }],
            stopReason: "stop",
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
            timestamp: Date.now(),
          },
        } as never;
      },
    };
    const service = new AgentService({
      catalog: {
        async list() {
          return [
            {
              id: "test",
              displayName: "Test",
              description: "Test Agent",
              packageName: target.packageName,
              packageVersion: target.packageVersion,
            },
          ];
        },
        async load() {
          return target;
        },
      },
      factory: await factory({ runtime }),
    });
    const session = await service.openSession({ agentId: "test" });

    const events: AgentServiceEvent[] = [];
    for await (const event of service.run({
      requestId: "request-1",
      agentId: "test",
      sessionId: session.sessionId,
      input: { type: "text", text: "say hello" },
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "started", requestId: "request-1", sessionId: session.sessionId },
      { type: "text_delta", text: "hello" },
      { type: "final_response", text: "hello" },
      { type: "completed" },
    ]);
    await service.dispose();
  });

  it("rejects a mismatched contribution before creating an application", async () => {
    const dispose = vi.fn(async () => undefined);
    await expect(
      (await factory()).create(agentPackage("test", { contributionId: "other", dispose })),
    ).rejects.toMatchObject({
      stage: "module_validation",
      cause: expect.objectContaining({
        message: expect.stringContaining("exactly one matching agent"),
      }),
    });
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("rejects a concrete Agent turn limit at the Module boundary", async () => {
    const target = agentPackage();
    const build = target.blueprint.build;
    target.blueprint.build = async (context) => {
      const module = await build(context);
      module.extension.contributions.agents![0]!.definition.maxTurns = 8;
      return module;
    };

    await expect((await factory()).create(target)).rejects.toMatchObject({
      stage: "module_validation",
      cause: expect.objectContaining({ message: expect.stringContaining("must not set maxTurns") }),
    });
  });

  it("rejects Tool contributions that differ from the immutable Plan", async () => {
    const target = agentPackage();
    const build = target.blueprint.build;
    target.blueprint.build = async (context) => {
      const module = await build(context);
      module.extension.contributions.tools = portableExtension().contributions.tools;
      module.extension.contributions.agents![0]!.tools = { include: ["portable_tool"] };
      return module;
    };

    await expect((await factory()).create(target)).rejects.toMatchObject({
      stage: "module_validation",
      cause: expect.objectContaining({ message: expect.stringContaining("Assembly Plan") }),
    });
  });

  it("reports the failing assembly stage without losing the root cause", async () => {
    const target = agentPackage();
    const cause = new Error("blueprint exploded");
    target.blueprint.build = async () => {
      throw cause;
    };

    const failure = await (await factory()).create(target).catch((error) => error);

    expect(failure).toBeInstanceOf(AgentAssemblyError);
    expect(failure).toMatchObject({
      code: "agent_assembly_failed",
      agentId: "test",
      stage: "blueprint_build",
      cause,
    });
  });

  it("reports the acquired resource when failure injection also breaks rollback", async () => {
    const disposeCause = new Error("module cleanup exploded");
    const failure = await (
      await factory()
    )
      .create(
        agentPackage("test", {
          contributionId: "invalid",
          dispose: () => {
            throw disposeCause;
          },
        }),
      )
      .catch((error) => error);

    expect(failure).toBeInstanceOf(AssemblyRollbackError);
    expect(failure).toMatchObject({
      code: "agent_assembly_rollback_failed",
      assemblyError: { stage: "module_validation" },
      cleanupFailures: [{ resource: "agent_module", error: disposeCause }],
    });
  });

  it("rolls back acquired resources in reverse order when Workspace initialization fails", async () => {
    const disposed: string[] = [];
    const target = agentPackage("test", {
      extensionDispose: () => {
        disposed.push("extension");
      },
      dispose: () => {
        disposed.push("module");
      },
    });

    const failure = await (
      await factory({ workspaceId: "0".repeat(64) })
    )
      .create(target)
      .catch((error) => error);

    expect(failure).toMatchObject({ stage: "workspace", source: "0".repeat(64) });
    expect(disposed).toEqual(["extension", "module"]);
  });

  it("rolls back acquired resources when Session restore fails", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "omni-agent-factory-workspace-"));
    const globalDirectory = await mkdtemp(join(tmpdir(), "omni-agent-factory-global-"));
    directories.push(workspaceRoot, globalDirectory);
    const workspaceId = createWorkspaceId(workspaceRoot);
    const sessionDirectory = join(globalDirectory, "workspaces", workspaceId, "sessions", "test");
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(join(sessionDirectory, "index.json"), "not-json");
    const disposed: string[] = [];

    const failure = await (
      await factory({ workspaceRoot, globalDirectory })
    )
      .create(
        agentPackage("test", {
          extensionDispose: () => {
            disposed.push("extension");
          },
          dispose: () => {
            disposed.push("module");
          },
        }),
      )
      .catch((error) => error);

    expect(failure).toMatchObject({ stage: "session", source: "session-repository" });
    expect(disposed).toEqual(["extension", "module"]);
  });

  it("rejects an Artifact Recovery capability that references an unexposed Tool", async () => {
    const disposed: string[] = [];
    const failure = await (
      await factory()
    )
      .create(
        agentPackage("test", {
          capabilities: {
            context: { artifactRecovery: { toolName: "missing", instruction: "read it" } },
          },
          extensionDispose: () => {
            disposed.push("extension");
          },
          dispose: () => {
            disposed.push("module");
          },
        }),
      )
      .catch((error) => error);

    expect(failure).toMatchObject({
      stage: "module_validation",
      source: "@omni-agent/agent-test",
    });
    expect(disposed).toEqual(["module"]);
  });

  it("propagates required Source failures and rolls back activated resources", async () => {
    const disposed: string[] = [];
    const sourceFailure = new Error("required source failed");
    const assemblyFactory = await factory({
      extensionSourceLoader: { load: async () => Promise.reject(sourceFailure) },
    });

    const failure = await assemblyFactory
      .create(
        agentPackage("test", {
          extensionDispose: () => {
            disposed.push("extension");
          },
          dispose: () => {
            disposed.push("module");
          },
        }),
      )
      .catch((error) => error);

    expect(failure).toMatchObject({
      stage: "extension_activation",
      source: "extension-sources",
      cause: sourceFailure,
    });
    expect(disposed).toEqual(["extension", "module"]);
  });

  it("isolates prompts, capabilities, and Sessions between Agent instances", async () => {
    const assemblyFactory = await factory();
    const codingCapabilities = { skills: undefined };
    const coding = await assemblyFactory.create(
      agentPackage("coding", { prompt: "coding prompt", capabilities: codingCapabilities }),
    );
    const financial = await assemblyFactory.create(
      agentPackage("financial-analysis", { prompt: "financial prompt" }),
    );

    expect(coding.application.agentConfig.systemPrompt).toBe("coding prompt");
    expect(financial.application.agentConfig.systemPrompt).toBe("financial prompt");
    expect(coding.capabilities).toBe(codingCapabilities);
    expect(financial.capabilities).not.toBe(coding.capabilities);
    expect(financial.application.sessions).not.toBe(coding.application.sessions);

    await coding.dispose();
    await financial.dispose();
  });

  it("keeps extension origin as evidence without bypassing explicit Tool exposure", async () => {
    const sourceLoader = (sourceOriginId: string): ExtensionSourceLoader => ({
      async load(references) {
        return {
          candidates: [
            {
              ...references[0]!,
              sourceOriginId,
              extension: portableExtension(),
            },
          ],
          diagnostics: [],
        };
      },
    });
    const first = await (
      await factory({ extensionSourceLoader: sourceLoader("first-source") })
    ).create(agentPackage("test"));
    const second = await (
      await factory({ extensionSourceLoader: sourceLoader("second-source") })
    ).create(agentPackage("test"));

    expect(first.assembly.extensions.find(({ id }) => id === "portable")?.sourceOriginId).toBe(
      "first-source",
    );
    expect(second.assembly.extensions.find(({ id }) => id === "portable")?.sourceOriginId).toBe(
      "second-source",
    );
    expect(first.application.agentConfig.tools).toEqual([]);
    expect(second.application.agentConfig.tools).toEqual([]);

    await first.dispose();
    await second.dispose();
  });

  it("isolates the same Agent across workspaces and restores it when returning", async () => {
    const globalDirectory = await mkdtemp(join(tmpdir(), "omni-agent-factory-global-"));
    const firstRoot = await mkdtemp(join(tmpdir(), "omni-agent-factory-first-"));
    const secondRoot = await mkdtemp(join(tmpdir(), "omni-agent-factory-second-"));
    directories.push(globalDirectory, firstRoot, secondRoot);

    const firstFactory = await factory({ workspaceRoot: firstRoot, globalDirectory });
    const first = await firstFactory.create(agentPackage());
    const firstSessionId = first.application.sessions.currentId;
    const secondFactory = await factory({ workspaceRoot: secondRoot, globalDirectory });
    const second = await secondFactory.create(agentPackage());
    const secondSessionId = second.application.sessions.currentId;
    expect(secondSessionId).not.toBe(firstSessionId);

    const firstIndex = join(
      globalDirectory,
      "workspaces",
      createWorkspaceId(firstRoot),
      "sessions",
      "test",
      "index.json",
    );
    const secondIndex = join(
      globalDirectory,
      "workspaces",
      createWorkspaceId(secondRoot),
      "sessions",
      "test",
      "index.json",
    );
    const secondIndexBeforeFirstMutation = await readFile(secondIndex, "utf8");

    const firstNewSessionId = await first.application.newSession();
    expect(firstNewSessionId).not.toBe(firstSessionId);
    expect(second.application.sessions.currentId).toBe(secondSessionId);
    await first.application.clearSession();
    expect(second.application.sessions.currentId).toBe(secondSessionId);
    expect(await readFile(secondIndex, "utf8")).toBe(secondIndexBeforeFirstMutation);
    expect(JSON.parse(await readFile(firstIndex, "utf8"))).not.toEqual(
      JSON.parse(await readFile(secondIndex, "utf8")),
    );
    await expect(access(join(globalDirectory, "sessions"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    await first.dispose();
    await second.dispose();

    const restored = await firstFactory.create(agentPackage());
    expect(restored.application.sessions.currentId).toBe(firstNewSessionId);
    await restored.dispose();
  });

  it("makes Agent instance disposal idempotent", async () => {
    const instance = await (await factory()).create(agentPackage());
    const dispose = vi.spyOn(instance.application, "dispose");
    await instance.dispose();
    await instance.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("injects an Agent context policy stage through capabilities", async () => {
    const apply = vi.fn<ContextPolicyStagePort["apply"]>(async (frame) => ({
      frame: structuredClone(frame) as never,
      decisions: [{ type: "custom" }],
    }));
    const instance = await (
      await factory()
    ).create(
      agentPackage("test", {
        capabilities: {
          context: { policyStages: [{ name: "custom", version: 1, apply }] },
        },
      }),
    );

    await instance.application.run("hello", {});
    expect(apply).toHaveBeenCalledOnce();
    await instance.dispose();
  });
});
