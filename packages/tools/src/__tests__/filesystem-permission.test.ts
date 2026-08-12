import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assessFilePath } from "../filesystem/permission/file-path-assessor";
import { createFilePathPreflight } from "../filesystem/permission/create-file-path-preflight";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((entry) => fs.rm(entry, { recursive: true, force: true })),
  );
});

describe("filesystem permission assessment", () => {
  it("distinguishes workspace and external paths", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "omni-path-workspace-"));
    const external = await fs.mkdtemp(path.join(os.tmpdir(), "omni-path-external-"));
    directories.push(workspace, external);
    await expect(
      assessFilePath(path.join(workspace, "a.ts"), workspace, "write"),
    ).resolves.toMatchObject({ risk: "write" });
    await expect(
      assessFilePath(path.join(external, "a.ts"), workspace, "write"),
    ).resolves.toMatchObject({ risk: "external" });
  });

  it("treats credential writes as privileged and templates as normal", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "omni-path-secrets-"));
    directories.push(workspace);
    await expect(
      assessFilePath(path.join(workspace, ".env"), workspace, "write"),
    ).resolves.toMatchObject({ risk: "privileged" });
    await expect(
      assessFilePath(path.join(workspace, ".env.example"), workspace, "write"),
    ).resolves.toMatchObject({ risk: "write" });
    await expect(
      assessFilePath(path.join(workspace, "config", ".npmrc"), workspace, "write"),
    ).resolves.toMatchObject({ risk: "privileged", enforcement: "policy" });
  });

  it("resolves traversal and symlinks against the actual workspace boundary", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "omni-path-boundary-"));
    const workspace = path.join(root, "workspace");
    const external = path.join(root, "external");
    directories.push(root);
    await fs.mkdir(workspace);
    await fs.mkdir(external);
    await fs.symlink(external, path.join(workspace, "linked"));

    await expect(
      assessFilePath(path.join(workspace, "..", "external", "data.txt"), workspace, "read"),
    ).resolves.toMatchObject({ risk: "external" });
    await expect(
      assessFilePath(path.join(workspace, "linked", "data.txt"), workspace, "read"),
    ).resolves.toMatchObject({ risk: "external" });
  });

  it("uses directory grants for external reads and exact grants for sensitive files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "omni-path-read-scope-"));
    const workspace = path.join(root, "workspace");
    const external = path.join(root, "reviews");
    directories.push(root);
    await fs.mkdir(workspace);
    await fs.mkdir(external);
    const canonicalExternal = await fs.realpath(external);

    const ordinary = await assessFilePath(path.join(external, "review.diff"), workspace, "read");
    const sensitive = await assessFilePath(path.join(workspace, ".env"), workspace, "read");

    expect(ordinary.persistentApprovalRequirements?.[0]?.approval).toMatchObject({
      kind: "filesystem_read_directory",
      label: `Always allow reads under ${canonicalExternal}`,
    });
    expect(ordinary.persistentApprovalRequirements?.[0]?.satisfiedBy).toContain(
      ordinary.persistentApprovalRequirements?.[0]?.approval.key,
    );
    expect(sensitive.persistentApprovalRequirements?.[0]?.approval).toMatchObject({
      kind: "filesystem_read_file",
      label: `Always allow reading ${path.join(await fs.realpath(workspace), ".env")}`,
    });
    expect(sensitive.persistentApprovalRequirements?.[0]?.satisfiedBy).toEqual([
      sensitive.persistentApprovalRequirements?.[0]?.approval.key,
    ]);
    expect(sensitive.persistentApprovalRequirements?.[0]?.satisfiedBy).not.toContain(
      ordinary.persistentApprovalRequirements?.[0]?.approval.key,
    );
  });

  it("uses a separate directory scope for external writes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "omni-path-write-scope-"));
    const workspace = path.join(root, "workspace");
    const external = path.join(root, "outside");
    directories.push(root);
    await fs.mkdir(workspace);
    await fs.mkdir(external);

    const assessment = await assessFilePath(path.join(external, "output.txt"), workspace, "write");

    expect(assessment.persistentApprovalRequirements?.[0]?.approval).toMatchObject({
      kind: "filesystem_write_directory",
      label: `Always allow writes under ${await fs.realpath(external)}`,
    });
  });

  it("rejects missing reads and dangling symlinks during preflight", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "omni-path-preflight-"));
    directories.push(root);
    const dangling = path.join(root, "dangling");
    await fs.symlink(path.join(root, "missing-target"), dangling);
    const preflight = createFilePathPreflight({
      parameter: "file_path",
      acceptedKinds: ["regular_file"],
      operation: "read",
    });

    await expect(
      preflight.validate({ file_path: path.join(root, "missing") }, { cwd: root }),
    ).resolves.toMatchObject({
      outcome: "error",
      result: { meta: { code: "read_failed" } },
    });
    await expect(preflight.validate({ file_path: dangling }, { cwd: root })).resolves.toMatchObject(
      {
        outcome: "error",
        result: { meta: { code: "unsupported_file" } },
      },
    );
  });

  it("keeps credential parents sensitive before env template exceptions", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "omni-workspace-"));
    directories.push(workspace);
    const credentialDirectory = path.join(os.homedir(), ".ssh");
    await expect(
      assessFilePath(path.join(credentialDirectory, ".env.example"), workspace, "read"),
    ).resolves.toMatchObject({ operationClass: "sensitive" });
  });
});
