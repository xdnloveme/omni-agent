import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadVendorPlugins } from "../config/provider-loader";
import {
  ProviderRepository,
  type ProviderConnectionDefinition,
} from "../config/provider-repository";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function workspace(): { cwd: string; globalDirectory: string } {
  const cwd = mkdtempSync(join(tmpdir(), "omni-project-providers-"));
  const globalDirectory = mkdtempSync(join(tmpdir(), "omni-global-providers-"));
  directories.push(cwd, globalDirectory);
  return { cwd, globalDirectory };
}

function writeProviders(directory: string, vendors: unknown): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "providers.json"), JSON.stringify({ version: 1, vendors }));
}

function connection(overrides: Record<string, unknown> = {}) {
  return {
    id: "default",
    displayName: "Default",
    providerId: "team-gateway",
    baseUrl: "https://models.example.com/v1",
    envVars: ["TEAM_GATEWAY_API_KEY"],
    protocol: "openai-completions",
    models: [{ id: "team-model", contextWindow: 128_000, maxTokens: 8_192 }],
    ...overrides,
  };
}

describe("ProviderRepository", () => {
  it("merges vendors by id and replaces matching project connections atomically", async () => {
    const { cwd, globalDirectory } = workspace();
    writeProviders(globalDirectory, [
      {
        id: "team",
        displayName: "Global Team",
        connections: [
          connection({ id: "default", providerId: "team-global" }),
          connection({ id: "backup", providerId: "team-backup" }),
        ],
      },
    ]);
    writeProviders(join(cwd, ".omni-agent"), [
      {
        id: "team",
        displayName: "Project Team",
        connections: [
          connection({
            id: "default",
            providerId: "team-project",
            baseUrl: "https://project.example.com/v1",
          }),
        ],
      },
    ]);

    const [vendor] = await new ProviderRepository({ cwd, globalDirectory }).list();

    expect(vendor.displayName).toBe("Project Team");
    expect(vendor.connections).toEqual([
      expect.objectContaining({
        id: "default",
        providerId: "team-project",
        baseUrl: "https://project.example.com/v1",
      }),
      expect.objectContaining({ id: "backup", providerId: "team-backup" }),
    ]);
  });

  it("loads one effective plugin with all merged connections", async () => {
    const { cwd, globalDirectory } = workspace();
    writeProviders(globalDirectory, [
      { id: "team", displayName: "Team", connections: [connection()] },
    ]);
    const repository = new ProviderRepository({ cwd, globalDirectory });

    const [plugin] = await loadVendorPlugins(repository);

    expect(plugin.vendor).toEqual(
      expect.objectContaining({
        id: "team",
        connections: [expect.objectContaining({ id: "default" })],
      }),
    );
  });

  it("rejects plaintext API keys in either layer", async () => {
    const { cwd, globalDirectory } = workspace();
    writeProviders(join(cwd, ".omni-agent"), [
      {
        id: "team",
        displayName: "Team",
        connections: [connection({ apiKey: "must-not-be-stored" })],
      },
    ]);

    await expect(new ProviderRepository({ cwd, globalDirectory }).list()).rejects.toThrow(
      "use keytar or an environment variable",
    );
  });

  it("reports the exact invalid connection field", async () => {
    const { cwd, globalDirectory } = workspace();
    writeProviders(join(cwd, ".omni-agent"), [
      {
        id: "team",
        displayName: "Team",
        connections: [connection({ baseUrl: "not-a-url" })],
      },
    ]);

    await expect(new ProviderRepository({ cwd, globalDirectory }).list()).rejects.toThrow(
      "connections[0].baseUrl must be an HTTP(S) URL",
    );
  });

  it("rejects duplicate model ids at the file boundary", async () => {
    const { cwd, globalDirectory } = workspace();
    writeProviders(join(cwd, ".omni-agent"), [
      {
        id: "team",
        displayName: "Team",
        connections: [
          connection({
            models: [
              { id: "same", contextWindow: 128_000, maxTokens: 8_192 },
              { id: "same", contextWindow: 64_000, maxTokens: 4_096 },
            ],
          }),
        ],
      },
    ]);

    await expect(new ProviderRepository({ cwd, globalDirectory }).list()).rejects.toThrow(
      "models contains duplicate model ids",
    );
  });

  it("validates the effective configuration before persisting an upsert", async () => {
    const { cwd, globalDirectory } = workspace();
    writeProviders(globalDirectory, [
      { id: "global", displayName: "Global", connections: [connection()] },
    ]);
    const repository = new ProviderRepository({ cwd, globalDirectory });

    await expect(
      repository.upsert({
        id: "project",
        displayName: "Project",
        connections: [connection() as ProviderConnectionDefinition],
      }),
    ).rejects.toThrow("duplicate provider id");
    expect((await repository.list()).some(({ id }) => id === "project")).toBe(false);
  });

  it("rejects vendors without connections at the repository boundary", async () => {
    const { cwd, globalDirectory } = workspace();
    const repository = new ProviderRepository({ cwd, globalDirectory });

    await expect(
      repository.upsert({ id: "empty", displayName: "Empty", connections: [] }),
    ).rejects.toThrow("connections must not be empty");
  });
});
