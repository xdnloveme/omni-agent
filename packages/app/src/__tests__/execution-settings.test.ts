import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ExecutionSettingsRepository, ExecutionSettingsService } from "../execution-settings";

describe("ExecutionSettingsService", () => {
  const workspaceA = "a".repeat(64);
  const workspaceB = "b".repeat(64);

  it("isolates settings and manages normalized filesystem roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-execution-settings-"));
    const service = new ExecutionSettingsService(new ExecutionSettingsRepository(root));
    await service.setMode(workspaceA, "coding", "autonomous");
    await service.setControlledNetworkEnabled(workspaceA, "coding", true);
    await service.addApprovedFilesystemRoots(workspaceA, "coding", [
      { path: "/outside/project/src", scope: "subtree", access: "read" },
      { path: "/outside/project", scope: "subtree", access: "read_write" },
    ]);

    await expect(service.getSettings(workspaceA, "coding")).resolves.toEqual({
      mode: "autonomous",
      controlledNetworkEnabled: true,
      approvedFilesystemRoots: [
        { path: "/outside/project", scope: "subtree", access: "read_write" },
      ],
    });
    await expect(service.getSettings(workspaceB, "coding")).resolves.toEqual({
      mode: "controlled",
      controlledNetworkEnabled: false,
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
      controlledNetworkEnabled: true,
      approvedFilesystemRoots: [],
    });
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ version: 5 });
    expect(repository.diagnostics).toContain(
      "Migrated execution settings from version 4 to version 5.",
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
      controlledNetworkEnabled: false,
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
      controlledNetworkEnabled: false,
      approvedFilesystemRoots: [],
    });
    expect(repository.diagnostics).toEqual([
      "Execution settings are invalid; using controlled defaults.",
    ]);

    await service.setControlledNetworkEnabled(workspaceA, "coding", true);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ version: 5 });
  });

  it("ignores malformed legacy permissions and keeps controlled defaults", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-execution-legacy-corrupt-"));
    await writeFile(join(root, "permissions.json"), "{not-json");
    const repository = new ExecutionSettingsRepository(root);
    const service = new ExecutionSettingsService(repository);

    await expect(service.getSettings(workspaceA, "coding")).resolves.toEqual({
      mode: "controlled",
      controlledNetworkEnabled: false,
      approvedFilesystemRoots: [],
    });
    expect(repository.diagnostics).toContain(
      "Legacy permissions are invalid; ignoring migration input.",
    );
  });
});
