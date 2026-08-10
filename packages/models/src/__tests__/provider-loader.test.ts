import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadLocalVendorPlugins } from "../local/provider-loader";
import { LocalProviderRepository } from "../local/provider-repository";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function projectWithProviders(providers: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), "omni-local-providers-"));
  directories.push(directory);
  mkdirSync(join(directory, ".omni-agent.local"));
  writeFileSync(
    join(directory, ".omni-agent.local", "providers.json"),
    JSON.stringify({ providers }),
  );
  return directory;
}

describe("loadLocalVendorPlugins", () => {
  it("loads validated provider definitions and defaults the historical protocol", async () => {
    const cwd = projectWithProviders([
      {
        id: "team-gateway",
        displayName: "Team Gateway",
        baseUrl: "https://models.example.com/v1",
        envVars: ["TEAM_GATEWAY_API_KEY"],
        models: [{ id: "team-model", contextWindow: 128_000, maxTokens: 8_192 }],
      },
    ]);

    const [plugin] = await loadLocalVendorPlugins(new LocalProviderRepository(cwd));
    expect(plugin.vendor).toEqual(expect.objectContaining({ id: "team-gateway" }));
  });

  it("accepts keytar migration aliases without treating them as stored secrets", async () => {
    const cwd = projectWithProviders([
      {
        id: "team-gateway",
        displayName: "Team Gateway",
        baseUrl: "https://models.example.com/v1",
        envVars: ["TEAM_GATEWAY_API_KEY"],
        credentialAliases: ["legacy-team-account"],
        models: [{ id: "team-model", contextWindow: 128_000, maxTokens: 8_192 }],
      },
    ]);

    await expect(loadLocalVendorPlugins(new LocalProviderRepository(cwd))).resolves.toHaveLength(1);
  });

  it("rejects plaintext API keys and directs callers to keytar or environment variables", async () => {
    const cwd = projectWithProviders([
      {
        id: "team-gateway",
        displayName: "Team Gateway",
        baseUrl: "https://models.example.com/v1",
        envVars: ["TEAM_GATEWAY_API_KEY"],
        apiKey: "must-not-be-stored",
        models: [{ id: "team-model", contextWindow: 128_000, maxTokens: 8_192 }],
      },
    ]);

    await expect(loadLocalVendorPlugins(new LocalProviderRepository(cwd))).rejects.toThrow(
      "use keytar or an environment variable",
    );
  });

  it("reports the exact invalid provider field", async () => {
    const cwd = projectWithProviders([
      {
        id: "team-gateway",
        displayName: "Team Gateway",
        baseUrl: "not-a-url",
        envVars: ["TEAM_GATEWAY_API_KEY"],
        models: [{ id: "team-model", contextWindow: 128_000, maxTokens: 8_192 }],
      },
    ]);

    await expect(loadLocalVendorPlugins(new LocalProviderRepository(cwd))).rejects.toThrow(
      "providers[0].baseUrl must be an HTTP(S) URL",
    );
  });

  it("rejects duplicate model ids at the file boundary", async () => {
    const cwd = projectWithProviders([
      {
        id: "team-gateway",
        displayName: "Team Gateway",
        baseUrl: "https://models.example.com/v1",
        envVars: ["TEAM_GATEWAY_API_KEY"],
        models: [
          { id: "same", contextWindow: 128_000, maxTokens: 8_192 },
          { id: "same", contextWindow: 64_000, maxTokens: 4_096 },
        ],
      },
    ]);

    await expect(loadLocalVendorPlugins(new LocalProviderRepository(cwd))).rejects.toThrow(
      "models contains duplicate model ids",
    );
  });
});
