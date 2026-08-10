import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateLegacyConfig } from "../config/config-migration";
import { ConfigService } from "../config/config-service";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("config migration", () => {
  it.each([
    ["openai", "https://api.openai.com/v1", "openai"],
    ["anthropic", "https://api.anthropic.com", "anthropic"],
    ["google", "https://generativelanguage.googleapis.com/v1beta", "google"],
    ["mistral", "https://api.mistral.ai", "mistral"],
    ["deepseek", "https://api.deepseek.com", "deepseek"],
    ["qwen", "https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen"],
    ["openrouter", "https://openrouter.ai/api/v1", "openrouter"],
  ])("maps the legacy %s provider to its current vendor", async (provider, endpoint, vendorId) => {
    await expect(
      migrateLegacyConfig({ provider, endpoint, model: "existing-model" }),
    ).resolves.toEqual({
      vendorId,
      connectionId: "default",
      modelId: "existing-model",
    });
  });

  it("maps legacy Kimi provider variants to Moonshot connections", async () => {
    await expect(
      migrateLegacyConfig({
        provider: "kimi-cn",
        endpoint: "https://api.moonshot.cn/v1",
        model: "kimi-k2.6",
      }),
    ).resolves.toEqual({ vendorId: "moonshot", connectionId: "cn", modelId: "kimi-k2.6" });
  });

  it("preserves a custom endpoint as a local provider plugin without storing a key", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omni-custom-provider-"));
    dirs.push(cwd);
    const selection = await migrateLegacyConfig(
      {
        provider: "custom",
        endpoint: "https://example.test/v1",
        model: "custom-model",
        contextWindow: 32_000,
      },
      { cwd },
    );
    expect(selection).toEqual({
      vendorId: "custom",
      connectionId: "default",
      modelId: "custom-model",
    });
    const stored = readFileSync(join(cwd, "omni.providers.json"), "utf-8");
    expect(stored).toContain("https://example.test/v1");
    expect(stored).not.toMatch(/api[_-]?key\s*[:=]\s*["']?sk-/i);
  });

  it("refuses to silently migrate a non-standard provider endpoint", async () => {
    await expect(
      migrateLegacyConfig({
        provider: "openai",
        endpoint: "https://gateway.example.test/v1",
        model: "gpt-compatible",
      }),
    ).rejects.toThrow("Cannot safely migrate a non-standard endpoint");
  });

  it("upserts the migrated custom provider without deleting existing entries", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omni-custom-provider-merge-"));
    dirs.push(cwd);
    const path = join(cwd, "omni.providers.json");
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        vendors: [
          {
            id: "existing",
            displayName: "Existing",
            connections: [
              {
                id: "default",
                displayName: "Default",
                providerId: "existing",
                baseUrl: "https://existing.example.test/v1",
                envVars: ["EXISTING_API_KEY"],
                protocol: "openai-completions",
                models: [{ id: "existing-model", contextWindow: 32_000, maxTokens: 4_096 }],
              },
            ],
          },
        ],
      }),
    );

    await migrateLegacyConfig(
      {
        provider: "custom",
        endpoint: "https://custom.example.test/v1",
        model: "custom-model",
      },
      { cwd },
    );

    const stored = JSON.parse(readFileSync(path, "utf-8")) as {
      vendors: Array<{ id: string }>;
    };
    expect(stored.vendors.map((provider) => provider.id)).toEqual(["existing", "custom"]);
  });

  it("atomically persists a safely migrated v2 config and keeps a v1 backup", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omni-config-cwd-"));
    const configDirectory = mkdtempSync(join(tmpdir(), "omni-config-home-"));
    dirs.push(cwd, configDirectory);
    const path = join(configDirectory, "config.json");
    writeFileSync(
      path,
      JSON.stringify({
        provider: "openai",
        endpoint: "https://api.openai.com/v1/",
        model: "gpt-test",
      }),
    );

    const service = new ConfigService({
      cwd,
      globalDirectory: configDirectory,
    });
    await expect(service.load()).resolves.toEqual({
      version: 2,
      model: { vendorId: "openai", connectionId: "default", modelId: "gpt-test" },
    });
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual(
      expect.objectContaining({ version: 2 }),
    );
    expect(readFileSync(`${path}.v1.backup`, "utf-8")).toContain('"provider":"openai"');
  });

  it("rejects plaintext credentials when loading an existing v2 config", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omni-config-secret-cwd-"));
    const configDirectory = mkdtempSync(join(tmpdir(), "omni-config-secret-home-"));
    dirs.push(cwd, configDirectory);
    writeFileSync(
      join(configDirectory, "config.json"),
      JSON.stringify({
        version: 2,
        model: {
          vendorId: "openai",
          connectionId: "default",
          modelId: "gpt-test",
          settings: { apiKeyValue: "must-not-load" },
        },
      }),
    );

    const service = new ConfigService({
      cwd,
      globalDirectory: configDirectory,
    });
    await expect(service.load()).resolves.toBeNull();
    expect(service.diagnostics).toEqual([
      expect.objectContaining({
        code: "invalid_config",
        message: "Secret values are not allowed in model configuration",
      }),
    ]);
  });

  it("uses global config when the project has no override", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omni-config-project-"));
    const globalDirectory = mkdtempSync(join(tmpdir(), "omni-config-global-"));
    dirs.push(cwd, globalDirectory);
    writeFileSync(
      join(globalDirectory, "config.json"),
      JSON.stringify({
        version: 2,
        model: { vendorId: "openai", connectionId: "default", modelId: "global-model" },
      }),
    );

    await expect(new ConfigService({ cwd, globalDirectory }).load()).resolves.toEqual({
      version: 2,
      model: { vendorId: "openai", connectionId: "default", modelId: "global-model" },
    });
  });

  it("treats the project model selection as an atomic override", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omni-config-project-override-"));
    const globalDirectory = mkdtempSync(join(tmpdir(), "omni-config-global-override-"));
    dirs.push(cwd, globalDirectory);
    writeFileSync(
      join(globalDirectory, "config.json"),
      JSON.stringify({
        version: 2,
        model: { vendorId: "openai", connectionId: "default", modelId: "global-model" },
      }),
    );
    writeFileSync(
      join(cwd, "omni.config.json"),
      JSON.stringify({
        version: 2,
        model: { vendorId: "anthropic", connectionId: "default", modelId: "project-model" },
      }),
    );

    await expect(new ConfigService({ cwd, globalDirectory }).load()).resolves.toEqual({
      version: 2,
      model: { vendorId: "anthropic", connectionId: "default", modelId: "project-model" },
    });
  });

  it("does not fall back to global config when the project override is invalid", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omni-config-invalid-project-"));
    const globalDirectory = mkdtempSync(join(tmpdir(), "omni-config-valid-global-"));
    dirs.push(cwd, globalDirectory);
    writeFileSync(
      join(globalDirectory, "config.json"),
      JSON.stringify({
        version: 2,
        model: { vendorId: "openai", connectionId: "default", modelId: "global-model" },
      }),
    );
    writeFileSync(join(cwd, "omni.config.json"), "not-json");
    const service = new ConfigService({ cwd, globalDirectory });

    await expect(service.load()).resolves.toBeNull();
    expect(service.diagnostics).toEqual([
      expect.objectContaining({ code: "invalid_config", source: "project" }),
    ]);
  });

  it("writes project config by default and global config only when requested", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omni-config-write-project-"));
    const globalDirectory = mkdtempSync(join(tmpdir(), "omni-config-write-global-"));
    dirs.push(cwd, globalDirectory);
    const service = new ConfigService({ cwd, globalDirectory });
    const projectConfig = {
      version: 2 as const,
      model: { vendorId: "openai", connectionId: "default", modelId: "project-model" },
    };
    const globalConfig = {
      version: 2 as const,
      model: { vendorId: "anthropic", connectionId: "default", modelId: "global-model" },
    };

    await service.save(projectConfig);
    await service.save(globalConfig, { scope: "global" });

    expect(JSON.parse(readFileSync(join(cwd, "omni.config.json"), "utf-8"))).toEqual(projectConfig);
    expect(JSON.parse(readFileSync(join(globalDirectory, "config.json"), "utf-8"))).toEqual(
      globalConfig,
    );
  });
});
