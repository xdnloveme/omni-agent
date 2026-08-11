import { describe, expect, it } from "vitest";
import type { AgentExtension } from "../extensions/types";
import { ExtensionManager } from "../extensions/extension-manager";
import {
  ModelRuntime,
  VendorRegistry,
  compatibleConnection,
  defineVendor,
} from "@omni-agent/models";

function extension(id: string, activate?: () => void): AgentExtension {
  return {
    manifest: { id, version: "1.0.0", apiVersion: 1 },
    contributions: {
      tools: [
        {
          name: `${id}_tool`,
          authorization: { kind: "static", risk: "read", reason: "test" },
          execution: { kind: "host" },
          timeout: { kind: "none" },
          description: "test",
          schema: { type: "object" },
          async execute() {
            return { content: [{ type: "text", text: "ok" }], isError: false };
          },
        },
      ],
      agents: [
        {
          definition: { id: `${id}_agent`, description: "test", instructions: "test" },
          tools: { include: [`${id}_tool`] },
        },
      ],
    },
    activate,
  };
}

describe("ExtensionManager", () => {
  it("registers and resolves declared contributions", async () => {
    const manager = new ExtensionManager({ cwd: process.cwd() });
    await manager.register(extension("sample"));
    const agent = manager.agents.get("sample_agent");
    expect(agent).toBeDefined();
    expect(manager.tools.resolve(agent!.tools).map((tool) => tool.name)).toEqual(["sample_tool"]);
  });

  it("removes all contributions when an extension is unregistered", async () => {
    const manager = new ExtensionManager({ cwd: process.cwd() });
    const removable = extension("removable");
    const middleware = { beforeModel() {} };
    removable.contributions.middleware = [middleware];
    await manager.register(removable);
    expect(manager.middleware).toEqual([middleware]);
    await manager.unregister("removable");
    expect(manager.agents.has("removable_agent")).toBe(false);
    expect(manager.tools.has("removable_tool")).toBe(false);
    expect(manager.list()).toEqual([]);
    expect(manager.middleware).toEqual([]);
  });

  it("rolls back all contributions when activation fails", async () => {
    const manager = new ExtensionManager({ cwd: process.cwd() });
    const broken = extension("broken", () => {
      throw new Error("activation failed");
    });
    broken.contributions.middleware = [{ beforeExecute() {} }];
    await expect(manager.register(broken)).rejects.toThrow("activation failed");
    expect(manager.agents.has("broken_agent")).toBe(false);
    expect(manager.tools.has("broken_tool")).toBe(false);
    expect(manager.middleware).toEqual([]);
  });

  it("keeps the activation error when extension cleanup also fails", async () => {
    const manager = new ExtensionManager({ cwd: process.cwd() });
    const broken = extension("cleanup-broken", () => {
      throw new Error("activation failed");
    });
    broken.dispose = async () => {
      throw new Error("cleanup failed");
    };

    await expect(manager.register(broken)).rejects.toThrow("activation failed");
    expect(manager.diagnostics).toContainEqual(
      expect.objectContaining({
        extensionId: "cleanup-broken",
        source: "activation-rollback",
        message: "cleanup failed",
      }),
    );
  });

  it("rejects an agent that exposes an unknown tool before registration", async () => {
    const manager = new ExtensionManager({ cwd: process.cwd() });
    const broken = extension("broken");
    broken.contributions.agents![0].tools = { include: ["missing_tool"] };

    await expect(manager.register(broken)).rejects.toThrow(
      "Agent broken_agent references unknown tool: missing_tool",
    );
    expect(manager.agents.has("broken_agent")).toBe(false);
    expect(manager.tools.has("broken_tool")).toBe(false);
  });

  it("rejects a tool without an authorization descriptor before registration", async () => {
    const manager = new ExtensionManager({ cwd: process.cwd() });
    const broken = extension("broken-permission");
    delete (broken.contributions.tools![0] as Partial<{ authorization: unknown }>).authorization;

    await expect(manager.register(broken)).rejects.toThrow(
      "Tool authorization descriptor is required",
    );
    expect(manager.tools.has("broken-permission_tool")).toBe(false);
    expect(manager.agents.has("broken-permission_agent")).toBe(false);
  });

  it("rejects a tool without an execution strategy before registration", async () => {
    const manager = new ExtensionManager({ cwd: process.cwd() });
    const broken = extension("broken-execution");
    delete (broken.contributions.tools![0] as Partial<{ execution: unknown }>).execution;

    await expect(manager.register(broken)).rejects.toThrow("Tool execution strategy is required");
    expect(manager.tools.has("broken-execution_tool")).toBe(false);
    expect(manager.agents.has("broken-execution_agent")).toBe(false);
  });

  it("rejects a tool without a timeout policy before registration", async () => {
    const manager = new ExtensionManager({ cwd: process.cwd() });
    const broken = extension("broken-timeout");
    delete (broken.contributions.tools![0] as Partial<{ timeout: unknown }>).timeout;

    await expect(manager.register(broken)).rejects.toThrow("Tool timeout policy is required");
    expect(manager.tools.has("broken-timeout_tool")).toBe(false);
    expect(manager.agents.has("broken-timeout_agent")).toBe(false);
  });

  it("isolates optional extension failures as diagnostics", async () => {
    const manager = new ExtensionManager({ cwd: process.cwd() });
    await manager.registerOptional(
      extension("broken", () => {
        throw new Error("activation failed");
      }),
      "local.mjs",
    );
    expect(manager.diagnostics).toEqual([
      expect.objectContaining({
        extensionId: "broken",
        source: "local.mjs",
        message: "activation failed",
      }),
    ]);
  });

  it("rolls back provider contributions when extension activation fails", async () => {
    const runtime = new ModelRuntime();
    const providers = runtime.createPluginManager(new VendorRegistry(), process.cwd());
    const manager = new ExtensionManager({ cwd: process.cwd(), modelProviders: providers });
    const broken = extension("provider-broken", () => {
      throw new Error("activation failed");
    });
    broken.contributions.providers = [
      defineVendor({
        id: "example-vendor",
        displayName: "Example",
        connections: [
          compatibleConnection({
            id: "default",
            displayName: "Example",
            providerId: "example-vendor",
            providerName: "Example",
            baseUrl: "https://example.test/v1",
            envVars: ["EXAMPLE_API_KEY"],
            protocol: "openai-completions",
            models: [{ id: "example-model", contextWindow: 32_000, maxTokens: 4_096 }],
          }),
        ],
      }),
    ];
    await expect(manager.register(broken)).rejects.toThrow("activation failed");
    expect(providers.hasProvider("example-vendor")).toBe(false);
    expect(providers.vendors.get("example-vendor")).toBeUndefined();
  });
});
