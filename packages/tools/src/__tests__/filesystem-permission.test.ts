import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assessFilePath } from "../filesystem/permission/file-path-assessor";

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
});
