import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PermissionRepository } from "../permissions/permission-repository";
import { PermissionService } from "../permissions/permission-service";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((entry) => rm(entry, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "omni-permission-service-"));
  directories.push(root);
  const repository = new PermissionRepository({ globalDirectory: root });
  return { repository, service: new PermissionService(repository) };
}

describe("PermissionService", () => {
  const grant = {
    toolIdentity: "builtin-coding:bash",
    toolName: "bash",
    scopeKey: "tool:routine",
    scopeKind: "tool_routine" as const,
    label: "Always approve routine bash operations",
  };

  it("defaults to standard mode and persists Agent-scoped approvals", async () => {
    const { service } = await fixture();
    await expect(service.getMode("coding")).resolves.toBe("standard");
    await service.saveGrants("coding", [grant]);
    await expect(
      service.getGrantedScopeKeys("coding", grant.toolIdentity, [grant.scopeKey]),
    ).resolves.toEqual([grant.scopeKey]);
    await expect(
      service.getGrantedScopeKeys("other", grant.toolIdentity, [grant.scopeKey]),
    ).resolves.toEqual([]);
  });

  it("supports mode changes and approval revocation", async () => {
    const { service } = await fixture();
    await service.setMode("coding", "supervised");
    await service.saveGrants("coding", [grant]);
    const approvals = await service.listPersistentApprovals("coding");
    expect(approvals).toHaveLength(1);
    await service.revokePersistentApproval("coding", approvals[0]!.id);
    expect(await service.listPersistentApprovals("coding")).toHaveLength(0);
    await expect(service.getMode("coding")).resolves.toBe("supervised");
  });

  it("keeps independent scopes for one tool and clears them together", async () => {
    const { service } = await fixture();
    await service.saveGrants("coding", [
      grant,
      {
        ...grant,
        scopeKey:
          "bash:executable:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        scopeKind: "bash_executable",
        label: "Always trust executable: mycli",
      },
    ]);

    expect(await service.listPersistentApprovals("coding")).toHaveLength(2);
    await service.clearPersistentApprovals("coding");
    expect(await service.listPersistentApprovals("coding")).toEqual([]);
  });

  it("fails closed when configuration is invalid", async () => {
    const { repository, service } = await fixture();
    await writeFile(repository.path, "not-json");
    await expect(service.getMode("coding")).resolves.toBe("supervised");
    expect(service.diagnostics[0]?.code).toBe("invalid_permissions");
  });
});
