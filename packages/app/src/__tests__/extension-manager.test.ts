import { describe, expect, it, vi } from "vitest";
import type { AgentExtension } from "../extensions/types";
import {
  ExtensionActivationRollbackError,
  ExtensionCleanupError,
  ExtensionManager,
} from "../extensions/extension-manager";
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
          access: { kind: "internal" },
          execution: { kind: "in_process" },
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

function vendor(id: string) {
  return defineVendor({
    id,
    displayName: id,
    connections: [
      compatibleConnection({
        id: "default",
        displayName: id,
        providerId: id,
        providerName: id,
        baseUrl: `https://${id}.test/v1`,
        envVars: [`${id.toUpperCase().replaceAll("-", "_")}_API_KEY`],
        protocol: "openai-completions",
        models: [{ id: `${id}-model`, contextWindow: 32_000, maxTokens: 4_096 }],
      }),
    ],
  });
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
    const middleware = { afterModel() {} };
    removable.contributions.middleware = [middleware];
    await manager.register(removable);
    expect(manager.middleware).toEqual([middleware]);
    await manager.unregister("removable");
    expect(manager.agents.has("removable_agent")).toBe(false);
    expect(manager.tools.has("removable_tool")).toBe(false);
    expect(manager.list()).toEqual([]);
    expect(manager.middleware).toEqual([]);
  });

  it("rejects unsupported runtime middleware members", async () => {
    const manager = new ExtensionManager({ cwd: process.cwd() });
    const legacy = extension("legacy-model-middleware");
    legacy.contributions.middleware = [{ beforeModel() {} } as never];

    await expect(manager.register(legacy)).rejects.toThrow(
      "Unsupported runtime middleware member beforeModel",
    );
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

  it("keeps context middleware ordered and rolls it back atomically", async () => {
    const manager = new ExtensionManager({ cwd: process.cwd() });
    const broken = extension("broken-context", () => {
      throw new Error("activation failed");
    });
    const first = {
      name: "first",
      version: 1,
      transform(draft: never) {
        return draft;
      },
    };
    const second = { ...first, name: "second" };
    broken.contributions.contextMiddleware = [first, second];

    await expect(manager.register(broken)).rejects.toThrow("activation failed");
    expect(manager.contextMiddleware).toEqual([]);
  });

  it("removes context middleware in extension disposal order", async () => {
    const manager = new ExtensionManager({ cwd: process.cwd() });
    const contribution = extension("context-owner");
    const first = {
      name: "first",
      version: 1,
      transform(draft: never) {
        return draft;
      },
    };
    const second = { ...first, name: "second" };
    contribution.contributions.contextMiddleware = [first, second];

    await manager.register(contribution);
    expect(manager.contextMiddleware).toEqual([first, second]);
    await manager.unregister("context-owner");
    expect(manager.contextMiddleware).toEqual([]);
  });

  it("keeps context policy stages ordered and rolls them back atomically", async () => {
    const manager = new ExtensionManager({ cwd: process.cwd() });
    const broken = extension("broken-policy", () => {
      throw new Error("activation failed");
    });
    const first = {
      name: "first",
      version: 1,
      async apply(frame: never) {
        return { frame, decisions: [] };
      },
    };
    const second = { ...first, name: "second" };
    broken.contributions.contextPolicyStages = [first, second];

    await expect(manager.register(broken)).rejects.toThrow("activation failed");
    expect(manager.contextPolicyStages).toEqual([]);
  });

  it("keeps the activation error when extension cleanup also fails", async () => {
    const manager = new ExtensionManager({ cwd: process.cwd() });
    const broken = extension("cleanup-broken", () => {
      throw new Error("activation failed");
    });
    broken.dispose = async () => {
      throw new Error("cleanup failed");
    };

    const failure = await manager.register(broken).catch((error) => error);
    expect(failure).toBeInstanceOf(ExtensionActivationRollbackError);
    expect(failure).toMatchObject({
      extensionId: "cleanup-broken",
      activationError: { message: "activation failed" },
      cleanupFailures: [{ resource: "extension", error: { message: "cleanup failed" } }],
    });
    expect(manager.list()).toEqual([]);
  });

  it("attempts every rollback cleanup when provider and extension cleanup fail", async () => {
    const providerCleanup = new Error("provider cleanup failed");
    const extensionCleanup = new Error("extension cleanup failed");
    const unregisterProvider = vi.fn(async (providerId: string) => {
      if (providerId === "vendor.cleanup-second") throw providerCleanup;
    });
    const providers = {
      register: vi.fn().mockResolvedValue(undefined),
      unregister: unregisterProvider,
    } as unknown as import("@omni-agent/models").VendorPluginManager;
    const manager = new ExtensionManager({ cwd: process.cwd(), modelProviders: providers });
    const broken = extension("provider-cleanup-broken", () => {
      throw new Error("activation failed");
    });
    broken.contributions.providers = [vendor("cleanup-first"), vendor("cleanup-second")];
    broken.dispose = vi.fn().mockRejectedValue(extensionCleanup);

    const failure = await manager.register(broken).catch((error) => error);

    expect(failure).toBeInstanceOf(ExtensionActivationRollbackError);
    expect(failure).toMatchObject({
      extensionId: "provider-cleanup-broken",
      activationError: { message: "activation failed" },
      cleanupFailures: [
        { resource: "provider:vendor.cleanup-second", error: providerCleanup },
        { resource: "extension", error: extensionCleanup },
      ],
    });
    expect(unregisterProvider.mock.calls).toEqual([
      ["vendor.cleanup-second"],
      ["vendor.cleanup-first"],
    ]);
    expect(broken.dispose).toHaveBeenCalledOnce();
    expect(manager.agents.has("provider-cleanup-broken_agent")).toBe(false);
    expect(manager.tools.has("provider-cleanup-broken_tool")).toBe(false);
    expect(manager.list()).toEqual([]);
  });

  it("attempts extension disposal when provider cleanup fails during unregister", async () => {
    const providerCleanup = new Error("provider cleanup failed");
    const providers = {
      register: vi.fn().mockResolvedValue(undefined),
      unregister: vi.fn().mockRejectedValue(providerCleanup),
    } as unknown as import("@omni-agent/models").VendorPluginManager;
    const manager = new ExtensionManager({ cwd: process.cwd(), modelProviders: providers });
    const contribution = extension("unregister-cleanup-broken");
    contribution.contributions.providers = [vendor("unregister-vendor")];
    contribution.dispose = vi.fn().mockResolvedValue(undefined);
    await manager.register(contribution);

    const failure = await manager.unregister(contribution.manifest.id).catch((error) => error);

    expect(failure).toBeInstanceOf(ExtensionCleanupError);
    expect(failure).toMatchObject({
      extensionId: "unregister-cleanup-broken",
      cleanupFailures: [{ resource: "provider:vendor.unregister-vendor", error: providerCleanup }],
    });
    expect(contribution.dispose).toHaveBeenCalledOnce();
    expect(manager.agents.has("unregister-cleanup-broken_agent")).toBe(false);
    expect(manager.tools.has("unregister-cleanup-broken_tool")).toBe(false);
    expect(manager.list()).toEqual([]);
  });

  it("attempts every extension disposal and aggregates normal shutdown failures", async () => {
    const manager = new ExtensionManager({ cwd: process.cwd() });
    const disposed: string[] = [];
    const first = extension("dispose-first");
    first.dispose = async () => {
      disposed.push("first");
      throw new Error("first cleanup failed");
    };
    const second = extension("dispose-second");
    second.dispose = async () => {
      disposed.push("second");
      throw new Error("second cleanup failed");
    };
    await manager.register(first);
    await manager.register(second);

    await expect(manager.dispose()).rejects.toBeInstanceOf(AggregateError);
    expect(disposed).toEqual(["second", "first"]);
    expect(manager.list()).toEqual([]);
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

  it("rejects a tool without an access descriptor before registration", async () => {
    const manager = new ExtensionManager({ cwd: process.cwd() });
    const broken = extension("broken-permission");
    delete (broken.contributions.tools![0] as Partial<{ access: unknown }>).access;

    await expect(manager.register(broken)).rejects.toThrow("Tool access descriptor is required");
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

  it("isolates optional extensions that conflict with Host-reserved commands", async () => {
    const manager = new ExtensionManager({
      cwd: process.cwd(),
      reservedCommandNames: ["help"],
    });
    const conflicting = extension("conflicting");
    conflicting.contributions.commands = [
      { name: "help", description: "conflict", execute: async () => undefined },
    ];

    await manager.registerOptional(conflicting, "local.mjs");

    expect(manager.commands.has("help")).toBe(false);
    expect(manager.diagnostics).toEqual([
      expect.objectContaining({
        extensionId: "conflicting",
        source: "local.mjs",
        message: "Command already registered: help",
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
    broken.contributions.providers = [vendor("example-vendor")];
    await expect(manager.register(broken)).rejects.toThrow("activation failed");
    expect(providers.hasProvider("example-vendor")).toBe(false);
    expect(providers.vendors.get("example-vendor")).toBeUndefined();
  });
});
