import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineAgent, type ContextPolicyStagePort, type ModelRuntimePort } from "@omni-agent/core";
import {
  AgentFactory,
  type AgentBlueprint,
  type AgentCapabilities,
} from "../application/agent-factory";
import type { ConfigService } from "../config/config-service";
import type { ModelService } from "../models/model-service";
import { createWorkspaceId } from "../workspaces/index";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function blueprint(
  id = "test",
  options: { moduleId?: string; prompt?: string; capabilities?: AgentCapabilities } = {},
): AgentBlueprint {
  return {
    id,
    build: () => ({
      id: options.moduleId ?? id,
      capabilities: options.capabilities ?? {},
      extension: {
        manifest: { id, version: "1.0.0", apiVersion: 1 },
        contributions: {
          agents: [
            {
              definition: defineAgent({
                id,
                description: id,
                instructions: options.prompt ?? "prompt",
              }),
              tools: { include: [] },
            },
          ],
        },
      },
    }),
  };
}

async function factory(options: { workspaceRoot?: string; globalDirectory?: string } = {}) {
  const workspaceRoot =
    options.workspaceRoot ?? (await mkdtemp(join(tmpdir(), "omni-agent-factory-workspace-")));
  const globalDirectory =
    options.globalDirectory ?? (await mkdtemp(join(tmpdir(), "omni-agent-factory-global-")));
  if (!options.workspaceRoot) directories.push(workspaceRoot);
  if (!options.globalDirectory) directories.push(globalDirectory);
  const selection = { vendorId: "test", connectionId: "default", modelId: "model" };
  const runtime: ModelRuntimePort = { async *stream() {} };
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
    resolveModel: vi.fn(async () => selection),
  } as unknown as ConfigService;
  return new AgentFactory({
    workspace: { id: createWorkspaceId(workspaceRoot), root: workspaceRoot },
    globalDirectory,
    modelService,
    configService,
    loadExtensions: false,
  });
}

describe("AgentFactory", () => {
  it("creates a complete Agent instance and reuses its persisted Session", async () => {
    const assemblyFactory = await factory();
    const first = await assemblyFactory.create(blueprint());
    const firstSessionId = first.application.sessions.currentId;
    await first.dispose();

    const second = await assemblyFactory.create(blueprint());
    expect(second.application.agentConfig.systemPrompt).toBe("prompt");
    expect(second.application.sessions.currentId).toBe(firstSessionId);
    await second.dispose();
  });

  it("rejects a mismatched module before creating an application", async () => {
    await expect(
      (await factory()).create(blueprint("test", { moduleId: "other" })),
    ).rejects.toThrow("Agent module id mismatch");
  });

  it("isolates prompts, capabilities, and Sessions between Agent instances", async () => {
    const assemblyFactory = await factory();
    const codingCapabilities = { skills: undefined };
    const coding = await assemblyFactory.create(
      blueprint("coding", { prompt: "coding prompt", capabilities: codingCapabilities }),
    );
    const financial = await assemblyFactory.create(
      blueprint("financial-analysis", { prompt: "financial prompt" }),
    );

    expect(coding.application.agentConfig.systemPrompt).toBe("coding prompt");
    expect(financial.application.agentConfig.systemPrompt).toBe("financial prompt");
    expect(coding.capabilities).toBe(codingCapabilities);
    expect(financial.capabilities).not.toBe(coding.capabilities);
    expect(financial.application.sessions).not.toBe(coding.application.sessions);

    await coding.dispose();
    await financial.dispose();
  });

  it("isolates the same Agent across workspaces and restores it when returning", async () => {
    const globalDirectory = await mkdtemp(join(tmpdir(), "omni-agent-factory-global-"));
    const firstRoot = await mkdtemp(join(tmpdir(), "omni-agent-factory-first-"));
    const secondRoot = await mkdtemp(join(tmpdir(), "omni-agent-factory-second-"));
    directories.push(globalDirectory, firstRoot, secondRoot);

    const firstFactory = await factory({ workspaceRoot: firstRoot, globalDirectory });
    const first = await firstFactory.create(blueprint());
    const firstSessionId = first.application.sessions.currentId;
    const secondFactory = await factory({ workspaceRoot: secondRoot, globalDirectory });
    const second = await secondFactory.create(blueprint());
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

    const restored = await firstFactory.create(blueprint());
    expect(restored.application.sessions.currentId).toBe(firstNewSessionId);
    await restored.dispose();
  });

  it("makes Agent instance disposal idempotent", async () => {
    const instance = await (await factory()).create(blueprint());
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
      blueprint("test", {
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
