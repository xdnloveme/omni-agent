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
  it("defaults to standard mode and persists Agent-scoped approvals", async () => {
    const { service } = await fixture();
    await expect(service.getMode("coding")).resolves.toBe("standard");
    await service.approveTool("coding", "builtin-coding:bash", "bash");
    await expect(service.isToolAlwaysApproved("coding", "builtin-coding:bash")).resolves.toBe(true);
    await expect(service.isToolAlwaysApproved("other", "builtin-coding:bash")).resolves.toBe(false);
  });

  it("supports mode changes and approval revocation", async () => {
    const { service } = await fixture();
    await service.setMode("coding", "supervised");
    await service.approveTool("coding", "builtin-coding:bash", "bash");
    expect(await service.listAlwaysApprovedTools("coding")).toHaveLength(1);
    await service.revokeAlwaysApprovedTool("coding", "builtin-coding:bash");
    expect(await service.listAlwaysApprovedTools("coding")).toHaveLength(0);
    await expect(service.getMode("coding")).resolves.toBe("supervised");
  });

  it("fails closed when configuration is invalid", async () => {
    const { repository, service } = await fixture();
    await writeFile(repository.path, "not-json");
    await expect(service.getMode("coding")).resolves.toBe("supervised");
    expect(service.diagnostics[0]?.code).toBe("invalid_permissions");
  });
});
