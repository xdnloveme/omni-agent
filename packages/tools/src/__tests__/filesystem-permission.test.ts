import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  PermissionGate,
  ToolAuthorizationRouter,
  ToolInputValidator,
  ToolInvocationRunner,
  type PermissionControlledTool,
} from "@omni-agent/core";
import { afterEach, describe, expect, it } from "vitest";
import { fileWriteTool } from "../filesystem/file-write";
import { assessFilePath } from "../filesystem/permission/file-path-assessor";
import { createFilePathPreflight } from "../filesystem/permission/create-file-path-preflight";
import { createSearchPathPermission } from "../search/permission/create-search-path-permission";
import {
  AuthorizedOperationPathChangedError,
  bindCanonicalPathInput,
  resolveAuthorizedOperationPath,
} from "../security/path/authorized-operation-path";

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
    await fs.mkdir(path.join(external, "nested"));
    const canonicalExternal = await fs.realpath(external);

    const ordinary = await assessFilePath(path.join(external, "review.diff"), workspace, "read");
    const nested = await assessFilePath(
      path.join(external, "nested", "review.diff"),
      workspace,
      "read",
    );
    const sensitive = await assessFilePath(path.join(workspace, ".env"), workspace, "read");

    expect(ordinary.persistentApprovalRequirements?.[0]?.approval).toMatchObject({
      kind: "filesystem_read_directory",
      label: `Always allow reads under ${canonicalExternal}`,
    });
    expect(ordinary.persistentApprovalRequirements?.[0]?.satisfiedBy).toContainEqual({
      key: ordinary.persistentApprovalRequirements?.[0]?.approval.key,
      kind: "filesystem_read_directory",
    });
    expect(nested.persistentApprovalRequirements?.[0]?.satisfiedBy).toContainEqual({
      key: ordinary.persistentApprovalRequirements?.[0]?.approval.key,
      kind: "filesystem_read_directory",
    });
    expect(sensitive.persistentApprovalRequirements?.[0]?.approval).toMatchObject({
      kind: "filesystem_read_file",
      label: `Always allow reading ${path.join(await fs.realpath(workspace), ".env")}`,
    });
    expect(sensitive.persistentApprovalRequirements?.[0]?.satisfiedBy).toEqual([
      {
        key: sensitive.persistentApprovalRequirements?.[0]?.approval.key,
        kind: "filesystem_read_file",
      },
    ]);
    expect(sensitive.persistentApprovalRequirements?.[0]?.satisfiedBy).not.toContainEqual({
      key: ordinary.persistentApprovalRequirements?.[0]?.approval.key,
      kind: "filesystem_read_directory",
    });
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

  it("executes against the canonical target bound during authorization", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "omni-path-binding-"));
    directories.push(root);
    const workspace = path.join(root, "workspace");
    const safe = path.join(workspace, "safe");
    const external = path.join(root, "external");
    const link = path.join(workspace, "linked");
    await fs.mkdir(safe, { recursive: true });
    await fs.mkdir(external);
    await fs.symlink(safe, link);
    if (fileWriteTool.authorization.kind !== "dynamic") {
      throw new Error("Expected file_write to use dynamic authorization");
    }
    const tool: PermissionControlledTool = {
      ...fileWriteTool,
      authorization: fileWriteTool.authorization,
      originId: "coding.file-write",
      toolIdentity: "coding.file-write:file_write",
    };
    const gate = new PermissionGate({
      policy: {
        evaluate: ({ assessment }) => ({
          outcome: assessment.risk === "write" ? "allow" : "deny",
          reason: "test",
        }),
      },
      grants: permissionGrants(),
      broker: {
        async request() {
          return "deny";
        },
      },
    });
    const authorization = await new ToolAuthorizationRouter(
      gate,
      new ToolInputValidator(),
    ).authorize({
      tool,
      input: { file_path: path.join(link, "proof.txt"), content: "proof" },
      context: {
        cwd: workspace,
        agentId: "coding",
        toolIdentity: tool.toolIdentity,
        toolCallId: "call-1",
      },
    });
    if (authorization.outcome !== "allowed") throw new Error("Expected authorization");

    const invocation = await new ToolInvocationRunner().invoke(authorization.call, [
      {
        async beforeExecute() {
          await fs.unlink(link);
          await fs.symlink(external, link);
        },
      },
    ]);

    expect(invocation.result.isError).toBe(false);
    await expect(fs.readFile(path.join(safe, "proof.txt"), "utf8")).resolves.toBe("proof");
    await expect(fs.readFile(path.join(external, "proof.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects execution when the bound canonical directory changes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "omni-path-revalidation-"));
    directories.push(root);
    const workspace = path.join(root, "workspace");
    const safe = path.join(workspace, "safe");
    const moved = path.join(workspace, "safe-moved");
    const external = path.join(root, "external");
    await fs.mkdir(safe, { recursive: true });
    await fs.mkdir(external);
    const bound = await bindCanonicalPathInput(
      { file_path: path.join(safe, "proof.txt") },
      "file_path",
      workspace,
    );
    await fs.rename(safe, moved);
    await fs.symlink(external, safe);

    await expect(
      resolveAuthorizedOperationPath(bound.file_path as string, workspace),
    ).rejects.toBeInstanceOf(AuthorizedOperationPathChangedError);
  });

  it("binds explicit search roots through the shared path authorization seam", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "omni-search-binding-"));
    directories.push(root);
    const workspace = path.join(root, "workspace");
    const source = path.join(workspace, "source");
    const link = path.join(workspace, "linked");
    await fs.mkdir(source, { recursive: true });
    await fs.symlink(source, link);
    const authorization = createSearchPathPermission("search_path");
    if (authorization.kind !== "dynamic") {
      throw new Error("Expected search paths to use dynamic authorization");
    }

    const bound = await authorization.bindInput?.(
      { search_path: link },
      {
        cwd: workspace,
        agentId: "coding",
        toolIdentity: "coding.grep:grep",
        toolCallId: "call-2",
      },
    );

    expect(bound?.search_path).toBe(await fs.realpath(source));
  });
});

function permissionGrants() {
  return {
    async getMode() {
      return "standard" as const;
    },
    async getGrantedScopeKeys() {
      return [];
    },
    async saveGrants() {},
  };
}
