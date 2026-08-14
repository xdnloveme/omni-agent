import { describe, expect, it, vi } from "vitest";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { ModelRuntime } from "../runtime/model-runtime";
import { VendorRegistry } from "../vendors/registry";
import { builtinVendorPlugins } from "../providers";
import { createVolcengineVendorPlugin } from "../providers/volcengine";
import { createProviderContribution, installProvider } from "../vendors/provider-contribution";
import { defineVendor } from "../vendors/define-vendor";
import { compatibleConnection } from "../providers/factories/compatible";
import { VendorPluginManager } from "../vendors/plugin-manager";
import { resolveOutputBudget } from "../vendors/output-budget";
import type { ProviderCollection, VendorPlugin } from "../vendors/types";

function plugin(id: string, dispose = vi.fn()): VendorPlugin {
  const faux = fauxProvider({ provider: `${id}-runtime`, models: [{ id: "model" }] });
  return {
    manifest: { id, version: "1.0.0", apiVersion: 1 },
    vendor: {
      id,
      displayName: id,
      connections: [{ id: "default", displayName: "Default", providerId: `${id}-runtime` }],
    },
    createProviders: () => [createProviderContribution(faux.provider)],
    dispose,
  };
}

describe("VendorPluginManager", () => {
  function createManager() {
    const runtime = new ModelRuntime();
    return { runtime, manager: runtime.createPluginManager(new VendorRegistry(), process.cwd()) };
  }

  it("separates model output capacity from the ordinary request budget", () => {
    expect(resolveOutputBudget({ contextWindow: 200_000, modelMaxOutputTokens: 128_000 })).toEqual({
      modelMaxOutputTokens: 128_000,
      requestedOutputTokens: 16_384,
    });
    expect(
      resolveOutputBudget({
        contextWindow: 200_000,
        modelMaxOutputTokens: 128_000,
        requestedOutputTokens: 32_000,
      }),
    ).toEqual({ modelMaxOutputTokens: 128_000, requestedOutputTokens: 32_000 });
  });

  it("applies the portable role policy inside the compatible Provider factory", async () => {
    const connection = compatibleConnection({
      id: "default",
      displayName: "Compatible",
      providerId: "custom-compatible",
      providerName: "Compatible",
      baseUrl: "https://models.example.com/v1",
      envVars: ["COMPATIBLE_API_KEY"],
      protocol: "openai-completions",
      models: [
        {
          id: "reasoning-model",
          contextWindow: 128_000,
          maxTokens: 8_192,
          reasoning: true,
        },
      ],
    });
    const [contribution] = await connection.factory.create(connection.config, {
      cwd: process.cwd(),
      vendorId: "compatible",
      connection: connection.definition,
    });
    const models = createModels();
    installProvider(models, contribution);

    expect(models.getModel("custom-compatible", "reasoning-model")?.compat).toEqual({
      supportsDeveloperRole: false,
    });
  });

  it("resolves models from the provider-owned catalog", async () => {
    const { runtime, manager } = createManager();
    for (const item of builtinVendorPlugins()) await manager.register(item);
    const [model] = runtime.listModels("deepseek");
    const resolved = await manager.resolve({
      vendorId: "deepseek",
      connectionId: "default",
      modelId: model.id,
    });
    expect(resolved).toEqual(
      expect.objectContaining({
        modelId: model.id,
        modelMaxOutputTokens: model.modelMaxOutputTokens,
        requestedOutputTokens: Math.min(16_384, model.modelMaxOutputTokens),
      }),
    );
    await expect(
      manager.resolve({
        vendorId: "deepseek",
        connectionId: "default",
        modelId: model.id,
        requestedOutputTokens: 1_024,
      }),
    ).resolves.toEqual(expect.objectContaining({ requestedOutputTokens: 1_024 }));
  });

  it("registers and resolves a vendor without model-specific registry code", async () => {
    const { manager } = createManager();
    await manager.register(plugin("sample"));
    await expect(
      manager.resolve({ vendorId: "sample", connectionId: "default", modelId: "model" }),
    ).resolves.toEqual(expect.objectContaining({ providerId: "sample-runtime", modelId: "model" }));
  });

  it("rolls back and disposes invalid contributions", async () => {
    const runtime = new ModelRuntime();
    const vendors = new VendorRegistry();
    const manager = runtime.createPluginManager(vendors, process.cwd());
    const base = plugin("broken");
    const broken: VendorPlugin = {
      ...base,
      vendor: {
        ...base.vendor,
        connections: [{ ...base.vendor.connections[0], providerId: "missing" }],
      },
    };
    await expect(manager.register(broken)).rejects.toThrow("unowned runtime provider");
    expect(vendors.get("broken")).toBeUndefined();
    // Validation happens before activation, so a provider was never committed.
    expect(manager.hasProvider("broken-runtime")).toBe(false);
    expect(broken.dispose).toHaveBeenCalledOnce();
  });

  it("rejects unauthenticated providers at the contribution boundary", () => {
    const faux = fauxProvider({ provider: "unauthenticated", models: [{ id: "model" }] });
    expect(() => createProviderContribution({ ...faux.provider, auth: {} })).toThrow(
      "Provider has no auth",
    );
  });

  it("keeps the active provider when a transactional replacement fails", async () => {
    const { manager } = createManager();
    const current = plugin("replaceable");
    await manager.register(current);
    const base = plugin("replaceable");
    const replacement: VendorPlugin = {
      ...base,
      vendor: {
        ...base.vendor,
        connections: [{ ...base.vendor.connections[0], providerId: "missing" }],
      },
    };

    await expect(manager.replace(replacement)).rejects.toThrow("unowned runtime provider");
    await expect(
      manager.resolve({
        vendorId: "replaceable",
        connectionId: "default",
        modelId: "model",
      }),
    ).resolves.toEqual(expect.objectContaining({ modelId: "model" }));
    expect(current.dispose).not.toHaveBeenCalled();
    expect(replacement.dispose).toHaveBeenCalledOnce();
  });

  it("validates provider-specific settings through the owning connection schema", async () => {
    const vendors = new VendorRegistry();
    const runtime = new ModelRuntime();
    const manager = runtime.createPluginManager(vendors, process.cwd());
    const base = plugin("cloud");
    const deployment: VendorPlugin = {
      ...base,
      vendor: {
        ...base.vendor,
        connections: [
          {
            ...base.vendor.connections[0],
            settingsSchema: {
              type: "object",
              required: ["deploymentId"],
              properties: { deploymentId: { type: "string", pattern: "^ep-" } },
              additionalProperties: false,
            },
          },
        ],
      },
    };
    await manager.register(deployment);
    await expect(
      manager.resolve({
        vendorId: "cloud",
        connectionId: "default",
        modelId: "model",
        settings: { deploymentId: "invalid" },
      }),
    ).rejects.toThrow("Invalid setting value");
    await expect(
      manager.resolve({
        vendorId: "cloud",
        connectionId: "default",
        modelId: "model",
        settings: { deploymentId: "ep-valid", apiKey: "must-not-be-config" },
      }),
    ).rejects.toThrow(/Secret setting|Unknown setting/);
  });

  it("maps cloud deployment ids without deriving model capabilities from them", async () => {
    const { manager } = createManager();
    await manager.register(
      createVolcengineVendorPlugin([
        {
          id: "kimi-k2",
          contextWindow: 128_000,
          maxTokens: 8_192,
        },
      ]),
    );
    await expect(
      manager.resolve({
        vendorId: "volcengine",
        connectionId: "cn-beijing",
        modelId: "kimi-k2",
        settings: { deploymentId: "ep-example" },
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        modelId: "kimi-k2",
        requestModelId: "ep-example",
        contextWindow: 128_000,
      }),
    );
  });

  it("keeps a committed replacement active when old plugin cleanup fails", async () => {
    const { manager } = createManager();
    const current = plugin("replaceable", vi.fn().mockRejectedValue(new Error("cleanup failed")));
    await manager.register(current);
    const replacement = plugin("replaceable");

    await expect(manager.replace(replacement)).resolves.toBeUndefined();
    await expect(
      manager.resolve({
        vendorId: "replaceable",
        connectionId: "default",
        modelId: "model",
      }),
    ).resolves.toEqual(expect.objectContaining({ providerId: "replaceable-runtime" }));
    expect(manager.diagnostics).toContainEqual(
      expect.objectContaining({
        pluginId: "replaceable",
        source: "replaced-plugin-cleanup",
        message: "cleanup failed",
      }),
    );
  });

  it("can roll back a prepared replacement before disposing the active plugin", async () => {
    const { manager } = createManager();
    const current = plugin("transactional");
    const replacement = plugin("transactional");
    await manager.register(current);

    const transaction = await manager.prepareReplace(replacement);
    expect(current.dispose).not.toHaveBeenCalled();
    expect(manager.getPlugin("transactional")).toBe(current);
    await transaction.rollback();

    expect(replacement.dispose).toHaveBeenCalledOnce();
    expect(current.dispose).not.toHaveBeenCalled();
    expect(manager.getPlugin("transactional")).toBe(current);
  });

  it("keeps a prepared registration isolated until commit", async () => {
    const { manager } = createManager();
    const pending = plugin("prepared");

    const transaction = await manager.prepareReplace(pending);
    expect(manager.getPlugin("prepared")).toBeUndefined();
    expect(manager.hasProvider("prepared-runtime")).toBe(false);

    await transaction.commit();
    expect(manager.getPlugin("prepared")).toBe(pending);
    expect(manager.hasProvider("prepared-runtime")).toBe(true);
  });

  it("switches a replacement only when the prepared transaction commits", async () => {
    const { manager } = createManager();
    const current = plugin("commit-boundary");
    const replacement = plugin("commit-boundary");
    await manager.register(current);

    const transaction = await manager.prepareReplace(replacement);
    expect(manager.getPlugin("commit-boundary")).toBe(current);
    await transaction.commit();

    expect(manager.getPlugin("commit-boundary")).toBe(replacement);
    expect(current.dispose).toHaveBeenCalledOnce();
  });

  it("rejects a stale transaction without disturbing the newer active plugin", async () => {
    const { manager } = createManager();
    const stale = plugin("stale");
    const newer = plugin("stale");

    const transaction = await manager.prepareReplace(stale);
    await manager.register(newer);

    await expect(transaction.commit()).rejects.toThrow("Provider transaction is stale");
    expect(manager.getPlugin("stale")).toBe(newer);
    expect(manager.hasProvider("stale-runtime")).toBe(true);
    expect(stale.dispose).toHaveBeenCalledOnce();
  });

  it("rolls back provider removal when unregister cannot commit", async () => {
    class FailingVendorRegistry extends VendorRegistry {
      failRemoval = false;

      override unregister(id: string): void {
        if (this.failRemoval) throw new Error("vendor removal failed");
        super.unregister(id);
      }
    }

    const vendors = new FailingVendorRegistry();
    const runtime = new ModelRuntime();
    const manager = runtime.createPluginManager(vendors, process.cwd());
    const current = plugin("removal-rollback");
    await manager.register(current);
    vendors.failRemoval = true;

    await expect(manager.unregister(current.manifest.id)).rejects.toThrow("vendor removal failed");

    expect(manager.getPlugin(current.manifest.id)).toBe(current);
    expect(manager.hasProvider("removal-rollback-runtime")).toBe(true);
    expect(current.dispose).not.toHaveBeenCalled();
  });

  it("keeps an immutable registry snapshot instead of a plugin-owned reference", async () => {
    const vendors = new VendorRegistry();
    const mutable = {
      id: "snapshot",
      displayName: "snapshot",
      connections: [{ id: "default", displayName: "Default", providerId: "snapshot-runtime" }],
    };
    vendors.register(mutable);
    mutable.displayName = "Changed outside registry";
    mutable.connections[0].displayName = "Changed connection";

    expect(vendors.get("snapshot")).toEqual(
      expect.objectContaining({
        displayName: "snapshot",
        connections: [expect.objectContaining({ displayName: "Default" })],
      }),
    );
  });

  it("rejects invalid connection schemas during plugin preparation", async () => {
    const { manager } = createManager();
    const base = plugin("invalid-schema");
    const invalid: VendorPlugin = {
      ...base,
      vendor: {
        ...base.vendor,
        connections: [
          {
            ...base.vendor.connections[0],
            settingsSchema: {
              type: "object",
              required: ["region"],
              properties: {},
              additionalProperties: false,
            },
          },
        ],
      },
    };

    await expect(manager.register(invalid)).rejects.toThrow("Required setting has no schema");
    expect(manager.hasProvider("invalid-schema-runtime")).toBe(false);
  });

  it("composes multiple connections with independent providers and protocols", async () => {
    const { manager } = createManager();
    await manager.register(
      defineVendor({
        id: "multi-region",
        displayName: "Multi Region",
        connections: [
          compatibleConnection({
            id: "global",
            displayName: "Global",
            providerId: "multi-region-global",
            providerName: "Multi Region Global",
            baseUrl: "https://global.example.com/v1",
            envVars: ["MULTI_GLOBAL_API_KEY"],
            protocol: "openai-completions",
            models: [{ id: "global-model", contextWindow: 32_000, maxTokens: 4_096 }],
          }),
          compatibleConnection({
            id: "cn",
            displayName: "China",
            providerId: "multi-region-cn",
            providerName: "Multi Region China",
            baseUrl: "https://cn.example.com/v1",
            envVars: ["MULTI_CN_API_KEY"],
            protocol: "anthropic-messages",
            models: [{ id: "cn-model", contextWindow: 64_000, maxTokens: 8_192 }],
          }),
        ],
      }),
    );

    await expect(
      manager.resolve({
        vendorId: "multi-region",
        connectionId: "global",
        modelId: "global-model",
      }),
    ).resolves.toEqual(expect.objectContaining({ providerId: "multi-region-global" }));
    await expect(
      manager.resolve({
        vendorId: "multi-region",
        connectionId: "cn",
        modelId: "cn-model",
      }),
    ).resolves.toEqual(expect.objectContaining({ providerId: "multi-region-cn" }));
  });

  it("settles and disposes a transaction even when commit and rollback both fail", async () => {
    const providers = new Map<string, ReturnType<ProviderCollection["getProvider"]>>();
    let failWrites = false;
    const collection: ProviderCollection = {
      getProvider: (id) => providers.get(id),
      setProvider: (provider) => {
        if (failWrites) throw new Error("provider write failed");
        providers.set(provider.id, provider);
      },
      deleteProvider: (id) => {
        providers.delete(id);
      },
      getModel: () => ({ id: "model", contextWindow: 32_000, maxOutputTokens: 4_096 }),
      refresh: async () => undefined,
    };
    const manager = new VendorPluginManager(collection, new VendorRegistry(), process.cwd());
    const current = plugin("rollback-failure");
    await manager.register(current);
    const replacement = plugin("rollback-failure");
    const transaction = await manager.prepareReplace(replacement);
    failWrites = true;

    await expect(transaction.commit()).rejects.toThrow("transaction and rollback failed");
    await expect(transaction.rollback()).resolves.toBeUndefined();
    expect(replacement.dispose).toHaveBeenCalledOnce();
    expect(manager.diagnostics).toContainEqual(
      expect.objectContaining({
        source: "replacement-rollback-failed",
      }),
    );
  });
});
