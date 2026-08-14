import { mkdtemp, rm } from "node:fs/promises";
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

async function factory() {
  const root = await mkdtemp(join(tmpdir(), "omni-agent-factory-"));
  directories.push(root);
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
    cwd: root,
    globalDirectory: root,
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
