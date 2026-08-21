import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderRepository, type ProviderDefinition } from "@omni-agent/models";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createModelService } from "../models/model-service";
import { ProviderRegistrationCoordinator } from "../models/provider-registration-coordinator";

const directories: string[] = [];

function providerDefinition(id: string): ProviderDefinition {
  return {
    id,
    displayName: id,
    connections: [
      {
        id: "default",
        displayName: "Default",
        providerId: id,
        baseUrl: `https://${id}.example.com/v1`,
        envVars: [`${id.replace(/-/g, "_").toUpperCase()}_API_KEY`],
        protocol: "openai-completions",
        models: [{ id: "test", contextWindow: 32_000, maxTokens: 4_096 }],
      },
    ],
  };
}

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
      globalDirectory: cwd,
      credentials,
      loadConfiguredProviders: false,
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

  it("rejects invalid project provider configuration instead of falling back", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omni-model-service-"));
    const globalDirectory = mkdtempSync(join(tmpdir(), "omni-model-global-"));
    directories.push(cwd, globalDirectory);
    writeFileSync(join(cwd, "omni.providers.json"), "invalid json");

    await expect(createModelService({ cwd, globalDirectory })).rejects.toThrow();
  });

  it("restores providers.json when the prepared runtime change cannot commit", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omni-model-registration-"));
    directories.push(cwd);
    const path = join(cwd, "omni.providers.json");
    const original = `${JSON.stringify({ version: 1, vendors: [] }, null, 2)}\n`;
    writeFileSync(path, original);
    const rollback = vi.fn(async () => undefined);

    await expect(
      new ProviderRegistrationCoordinator({
        providerPlugins: {
          prepareReplace: vi.fn(async () => ({
            commit: async () => {
              throw new Error("stale transaction");
            },
            rollback,
          })),
        },
        providers: new ProviderRepository({ cwd }),
      }).register(providerDefinition("local-test")),
    ).rejects.toThrow("stale transaction");

    expect(rollback).not.toHaveBeenCalled();
    expect(readFileSync(path, "utf-8")).toBe(original);
  });

  it("serializes registrations that share a provider repository", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omni-model-registration-queue-"));
    const globalDirectory = mkdtempSync(join(tmpdir(), "omni-model-global-"));
    directories.push(cwd, globalDirectory);
    const providers = new ProviderRepository({ cwd, globalDirectory });
    let releaseFirstCommit!: () => void;
    const firstCommitReleased = new Promise<void>((resolve) => {
      releaseFirstCommit = resolve;
    });
    let markFirstCommitStarted!: () => void;
    const firstCommitStarted = new Promise<void>((resolve) => {
      markFirstCommitStarted = resolve;
    });
    let prepared = 0;
    const prepareReplace = vi.fn(async () => {
      prepared += 1;
      const sequence = prepared;
      return {
        commit: async () => {
          if (sequence === 1) {
            markFirstCommitStarted();
            await firstCommitReleased;
          }
        },
        rollback: async () => undefined,
      };
    });
    const coordinator = new ProviderRegistrationCoordinator({
      providerPlugins: { prepareReplace },
      providers,
    });

    const first = coordinator.register(providerDefinition("first"));
    await firstCommitStarted;
    const second = coordinator.register(providerDefinition("second"));
    await Promise.resolve();
    expect(prepareReplace).toHaveBeenCalledTimes(1);

    releaseFirstCommit();
    await Promise.all([first, second]);
    expect(prepareReplace).toHaveBeenCalledTimes(2);
    expect((await providers.list()).map(({ id }) => id)).toEqual(["first", "second"]);
  });

  it("preserves repository and rollback failures together", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "omni-model-registration-errors-"));
    directories.push(cwd);
    const path = join(cwd, "omni.providers.json");
    const coordinator = new ProviderRegistrationCoordinator({
      providerPlugins: {
        prepareReplace: vi.fn(async () => {
          writeFileSync(path, "invalid json");
          return {
            commit: async () => undefined,
            rollback: async () => {
              throw new Error("rollback failed");
            },
          };
        }),
      },
      providers: new ProviderRepository({ cwd }),
    });

    const error = await coordinator.register(providerDefinition("broken")).catch((value) => value);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([
      expect.objectContaining({ message: expect.stringContaining("Invalid JSON file") }),
      expect.objectContaining({ message: "rollback failed" }),
    ]);
  });
});
