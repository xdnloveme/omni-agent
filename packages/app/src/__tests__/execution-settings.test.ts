import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ExecutionSettingsRepository, ExecutionSettingsService } from "../execution-settings";

describe("ExecutionSettingsService", () => {
  const workspaceA = "a".repeat(64);
  const workspaceB = "b".repeat(64);

  it("persists combined approval atomically and retains prior settings on invalid updates", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-combined-access-"));
    const repository = new ExecutionSettingsRepository(root);
    const service = new ExecutionSettingsService(repository);
    const access = {
      scopes: [{ path: "/outside", scope: "subtree" as const, access: "read" as const }],
      targets: [{ scheme: "http" as const, host: "localhost", port: 3000 }],
    };
    await service.addApprovedAccess(workspaceA, "coding", access);
    const before = await readFile(repository.path, "utf8");
    await expect(
      service.addApprovedAccess(workspaceA, "coding", {
        scopes: [{ path: "/another", scope: "subtree", access: "read_write" }],
        targets: Array.from({ length: 65 }, (_, i) => ({
          scheme: "https",
          host: `server-${i}.test`,
          port: 443,
        })),
      }),
    ).rejects.toThrow("cannot exceed");
    expect(await readFile(repository.path, "utf8")).toBe(before);
    const reloaded = new ExecutionSettingsService(new ExecutionSettingsRepository(root));
    expect(await reloaded.getSettings(workspaceA, "coding")).toMatchObject({
      approvedFilesystemRoots: access.scopes,
      approvedNetworkTargets: access.targets,
    });
    expect(await reloaded.getSettings(workspaceB, "coding")).toMatchObject({
      approvedFilesystemRoots: [],
      approvedNetworkTargets: [],
    });
  });

  it("isolates settings and manages normalized filesystem roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-execution-settings-"));
    const service = new ExecutionSettingsService(new ExecutionSettingsRepository(root));
    await service.setMode(workspaceA, "coding", "autonomous");
    await service.addApprovedNetworkTargets(workspaceA, "coding", [
      { scheme: "https", host: "EXAMPLE.com.", port: 443 },
    ]);
    await service.addApprovedAccess(workspaceA, "coding", {
      targets: [],
      scopes: [
        { path: "/outside/project/src", scope: "subtree", access: "read" },
        { path: "/outside/project", scope: "subtree", access: "read_write" },
      ],
    });

    await expect(service.getSettings(workspaceA, "coding")).resolves.toEqual({
      mode: "autonomous",
      approvedNetworkTargets: [{ scheme: "https", host: "example.com", port: 443 }],
      approvedFilesystemRoots: [
        { path: "/outside/project", scope: "subtree", access: "read_write" },
      ],
    });
    await expect(service.getSettings(workspaceB, "coding")).resolves.toEqual({
      mode: "controlled",
      approvedNetworkTargets: [],
      approvedFilesystemRoots: [],
    });
    const reloaded = new ExecutionSettingsService(new ExecutionSettingsRepository(root));
    await expect(reloaded.getSettings(workspaceA, "coding")).resolves.toMatchObject({
      approvedNetworkTargets: [{ scheme: "https", host: "example.com", port: 443 }],
    });
    await expect(reloaded.getSettings(workspaceA, "financial-analysis")).resolves.toEqual({
      mode: "controlled",
      approvedNetworkTargets: [],
      approvedFilesystemRoots: [],
    });
    await service.clearApprovedFilesystemRoots(workspaceA, "coding");
    await expect(service.getSettings(workspaceA, "coding")).resolves.toMatchObject({
      approvedFilesystemRoots: [],
    });
  });

  it("migrates version 4 before treating configuration as invalid", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-execution-v4-"));
    const path = join(root, "execution-settings.json");
    await writeFile(
      path,
      JSON.stringify({
        version: 4,
        workspaces: {
          [workspaceA]: {
            agents: {
              coding: { mode: "autonomous", controlledNetworkEnabled: true },
            },
          },
        },
      }),
    );
    const repository = new ExecutionSettingsRepository(root);
    const service = new ExecutionSettingsService(repository);

    await expect(service.getSettings(workspaceA, "coding")).resolves.toEqual({
      mode: "autonomous",
      approvedNetworkTargets: [],
      approvedFilesystemRoots: [],
    });
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ version: 6 });
    expect(repository.diagnostics).toContain(
      "Migrated execution settings from version 4 to version 6.",
    );
    expect(repository.diagnostics).toContain(
      "coarse_network_grant_discarded: Discarded 1 coarse network grant(s) while migrating to target-scoped network access.",
    );
  });

  it("migrates legacy permissions to controlled mode and discards grants", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-execution-v3-"));
    await writeFile(
      join(root, "permissions.json"),
      JSON.stringify({
        version: 3,
        agents: {
          coding: { mode: "supervised", persistentApprovals: [{ grantId: "legacy" }] },
        },
      }),
    );
    const repository = new ExecutionSettingsRepository(root);
    const service = new ExecutionSettingsService(repository);

    await expect(service.getSettings(workspaceA, "coding")).resolves.toEqual({
      mode: "controlled",
      approvedNetworkTargets: [],
      approvedFilesystemRoots: [],
    });
    expect(repository.diagnostics).toContain(
      "Discarded 1 legacy persistent approval(s) for coding.",
    );
  });

  it("fails closed when execution settings contain malformed JSON", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-execution-corrupt-"));
    const path = join(root, "execution-settings.json");
    await writeFile(path, "{not-json");
    const repository = new ExecutionSettingsRepository(root);
    const service = new ExecutionSettingsService(repository);

    await expect(service.getSettings(workspaceA, "coding")).resolves.toEqual({
      mode: "controlled",
      approvedNetworkTargets: [],
      approvedFilesystemRoots: [],
    });
    expect(repository.diagnostics).toEqual([
      "Execution settings are invalid; using controlled defaults.",
    ]);

    await service.addApprovedNetworkTargets(workspaceA, "coding", [
      { scheme: "https", host: "example.com", port: 443 },
    ]);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ version: 6 });
  });

  it("fails closed when persisted network targets are not canonical", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-execution-noncanonical-"));
    const path = join(root, "execution-settings.json");
    await writeFile(
      path,
      JSON.stringify({
        version: 6,
        workspaces: {
          [workspaceA]: {
            agents: {
              coding: {
                mode: "controlled",
                approvedNetworkTargets: [{ scheme: "https", host: "EXAMPLE.com.", port: 443 }],
                approvedFilesystemRoots: [],
              },
            },
          },
        },
      }),
    );
    const repository = new ExecutionSettingsRepository(root);
    const service = new ExecutionSettingsService(repository);

    await expect(service.getSettings(workspaceA, "coding")).resolves.toEqual({
      mode: "controlled",
      approvedNetworkTargets: [],
      approvedFilesystemRoots: [],
    });
    expect(repository.diagnostics).toContain(
      "Execution settings are invalid; using controlled defaults.",
    );
  });

  it("ignores malformed legacy permissions and keeps controlled defaults", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-execution-legacy-corrupt-"));
    await writeFile(join(root, "permissions.json"), "{not-json");
    const repository = new ExecutionSettingsRepository(root);
    const service = new ExecutionSettingsService(repository);

    await expect(service.getSettings(workspaceA, "coding")).resolves.toEqual({
      mode: "controlled",
      approvedNetworkTargets: [],
      approvedFilesystemRoots: [],
    });
    expect(repository.diagnostics).toContain(
      "Legacy permissions are invalid; ignoring migration input.",
    );
  });
});
