import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalProviderRepository } from "@omni-agent/models";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createModelService } from "../models/model-service";
import { LocalProviderRegistrationCoordinator } from "../models/local-provider-registration-coordinator";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("ModelService", () => {
  it("accepts an injected credential store and exposes credential diagnostics separately", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omni-model-credentials-"));
    directories.push(cwd);
    const credentials = {
      read: vi.fn(async () => undefined),
      list: vi.fn(async () => []),
      modify: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      reconcile: vi.fn(async () => ({
        diagnostics: [
          {
            code: "corrupt_index_quarantined" as const,
            message: "Credential index was corrupt and has been quarantined",
          },
        ],
      })),
    };

    const service = await createModelService({
      cwd,
      credentials,
      loadLocalProviders: false,
    });

    expect(credentials.reconcile).toHaveBeenCalledOnce();
    expect(service.diagnostics).toEqual([
      {
        code: "corrupt_credential_index_quarantined",
        source: "credentials",
        message: "Credential index was corrupt and has been quarantined",
      },
    ]);
    expect(service.providerPlugins.diagnostics).toEqual([]);
    await service.dispose();
  });

  it("isolates invalid optional local provider configuration", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omni-model-service-"));
    directories.push(cwd);
    mkdirSync(join(cwd, ".omni-agent.local"), { recursive: true });
    writeFileSync(join(cwd, ".omni-agent.local/providers.json"), "invalid json");

    const service = await createModelService({ cwd });
    expect(service.listVendors().some((vendor) => vendor.id === "openai")).toBe(true);
    expect(service.providerPlugins.diagnostics).toContainEqual(
      expect.objectContaining({ pluginId: "local.providers" }),
    );
    await service.dispose();
  });

  it("restores providers.json when the prepared runtime change cannot commit", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omni-model-registration-"));
    directories.push(cwd);
    const localDirectory = join(cwd, ".omni-agent.local");
    const path = join(localDirectory, "providers.json");
    mkdirSync(localDirectory, { recursive: true });
    const original = `${JSON.stringify({ providers: [] }, null, 2)}\n`;
    writeFileSync(path, original);
    const rollback = vi.fn(async () => undefined);

    await expect(
      new LocalProviderRegistrationCoordinator({
        providerPlugins: {
          prepareReplace: vi.fn(async () => ({
            commit: async () => {
              throw new Error("stale transaction");
            },
            rollback,
          })),
        },
        localProviders: new LocalProviderRepository(cwd),
      }).register({
        id: "local-test",
        displayName: "Local Test",
        baseUrl: "https://models.example.com/v1",
        envVars: ["LOCAL_TEST_API_KEY"],
        protocol: "openai-completions",
        models: [{ id: "test", contextWindow: 32_000, maxTokens: 4_096 }],
      }),
    ).rejects.toThrow("stale transaction");

    expect(rollback).not.toHaveBeenCalled();
    expect(readFileSync(path, "utf-8")).toBe(original);
  });
});
