import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PermissionRepository } from "../permissions/permission-repository";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((entry) => rm(entry, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "omni-permissions-"));
  directories.push(root);
  return { root, repository: new PermissionRepository({ globalDirectory: root }) };
}

describe("PermissionRepository", () => {
  it("creates and reads permission configuration", async () => {
    const { repository } = await fixture();
    await repository.update((current) => ({
      ...current,
      agents: {
        coding: { mode: "standard", alwaysApproveTools: [] },
      },
    }));
    await expect(repository.read()).resolves.toMatchObject({
      version: 2,
      agents: { coding: { mode: "standard" } },
    });
    expect((await stat(repository.path)).mode & 0o777).toBe(0o600);
  });

  it("serializes updates from independent repository instances", async () => {
    const { root, repository } = await fixture();
    const other = new PermissionRepository({ globalDirectory: root });
    await Promise.all([
      repository.update((current) => ({
        ...current,
        agents: { ...current.agents, coding: { mode: "standard", alwaysApproveTools: [] } },
      })),
      other.update((current) => ({
        ...current,
        agents: { ...current.agents, financial: { mode: "supervised", alwaysApproveTools: [] } },
      })),
    ]);
    expect(Object.keys((await repository.read())!.agents).sort()).toEqual(["coding", "financial"]);
  });

  it("rejects malformed configuration", async () => {
    const { repository } = await fixture();
    await writeFile(repository.path, JSON.stringify({ version: 99 }));
    await expect(repository.read()).rejects.toThrow("format is invalid");
    await expect(repository.update((current) => ({ ...current, agents: {} }))).rejects.toThrow(
      "format is invalid",
    );
  });

  it("rejects an invalid update result", async () => {
    const { repository } = await fixture();
    await expect(
      repository.update(() => ({ version: 2, agents: { Coding: {} } }) as never),
    ).rejects.toThrow("invalid configuration");
    await expect(repository.read()).resolves.toBeUndefined();
  });

  it("migrates recognized v1 identities and drops unscoped approvals", async () => {
    const { repository } = await fixture();
    await writeFile(
      repository.path,
      JSON.stringify({
        version: 1,
        agents: {
          coding: {
            mode: "supervised",
            alwaysApproveTools: [
              { toolIdentity: "coding:bash", toolName: "bash" },
              { toolIdentity: "unscoped:legacy", toolName: "legacy" },
            ],
          },
        },
      }),
    );

    await expect(repository.read()).resolves.toEqual({
      version: 2,
      agents: {
        coding: {
          mode: "supervised",
          alwaysApproveTools: [{ toolIdentity: "builtin-coding:bash", toolName: "bash" }],
        },
      },
    });
    expect(repository.diagnostics).toEqual([
      "Dropped unrecognized v1 tool identity: unscoped:legacy",
    ]);
  });

  it("migrates an invalid v1 mode to supervised", async () => {
    const { repository } = await fixture();
    await writeFile(
      repository.path,
      JSON.stringify({
        version: 1,
        agents: { coding: { mode: "invalid", alwaysApproveTools: [] } },
      }),
    );

    await expect(repository.read()).resolves.toMatchObject({
      agents: { coding: { mode: "supervised" } },
    });
  });
});
