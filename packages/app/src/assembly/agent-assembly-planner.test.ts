import { describe, expect, it, vi } from "vitest";
import { AgentAssemblyPlanner } from "./agent-assembly-planner";
import type { ResolvedAgentAssemblyInput } from "./contracts";

describe("AgentAssemblyPlanner", () => {
  it("produces a frozen resource-free plan without executing the Blueprint", () => {
    const build = vi.fn();
    const input = {
      agentPackage: {
        packageName: "@omni-agent/agent-test",
        packageVersion: "1.0.0",
        manifest: {
          apiVersion: "omni-agent/v2",
          kind: "Agent",
          metadata: { id: "test", displayName: "Test" },
          runtime: { blueprintApiVersion: 2 },
          description: "Test",
          composition: {
            prompt: { profile: "test.default", contributors: [] },
            tools: { sequence: [] },
            capabilities: {},
          },
        },
        blueprint: {
          descriptor: {
            promptProfiles: [
              { id: "test.default", displayName: "Test prompt", description: "Test prompt" },
            ],
            promptContributors: [],
            toolBundles: [],
            tools: [],
            capabilities: { skills: [], artifactRecovery: [] },
          },
          build,
        },
      },
      workspace: { id: "workspace", root: "/workspace" },
      workspaceRoots: ["/workspace"],
      globalDirectory: "/global",
      configService: {},
      modelService: {},
      host: { interactionSurface: {}, reservedCommandNames: [] },
      modelSelection: { vendorId: "vendor", connectionId: "default", modelId: "model" },
      resolvedModel: {
        vendorId: "vendor",
        connectionId: "default",
        modelId: "model",
        providerId: "provider",
        contextWindow: 1_000,
        modelMaxOutputTokens: 100,
        requestedOutputTokens: 100,
        settings: { nested: { enabled: true } },
      },
      extensionSources: [],
    } as unknown as ResolvedAgentAssemblyInput;

    const plan = new AgentAssemblyPlanner().plan(input);

    expect(build).not.toHaveBeenCalled();
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.workspaceRoots)).toBe(true);
    expect(Object.isFrozen(plan.modelSelection)).toBe(true);
    expect(Object.isFrozen(plan.manifest.metadata)).toBe(true);
    expect(Object.isFrozen(plan.resolvedModel.settings?.nested as object)).toBe(true);
    expect(Object.isFrozen(plan.extensionSources)).toBe(true);
    expect(Object.isFrozen(plan.composition)).toBe(true);
    expect(plan).not.toHaveProperty("tools");
    expect(plan).not.toHaveProperty("systemPrompt");
    expect(plan).not.toHaveProperty("blueprint");
    expect(plan).not.toHaveProperty("configService");
    expect(plan).not.toHaveProperty("modelService");
    expect(plan).not.toHaveProperty("host");
    expect(plan).not.toHaveProperty("extensionSourceLoader");

    (input.agentPackage.manifest.metadata as { displayName: string }).displayName = "Mutated";
    expect(plan.manifest.metadata.displayName).toBe("Test");
    expect(new AgentAssemblyPlanner().plan(input)).toEqual(new AgentAssemblyPlanner().plan(input));
  });
});
