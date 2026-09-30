import path from "node:path";
import { mkdtemp, mkdir, symlink, realpath, rm } from "node:fs/promises";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { evaluateFilesystemScopePolicy } from "../security/path/filesystem-scope-policy";
import { createSearchAccess } from "../search/access/create-search-access";
import { analyzeShellAccess } from "../shell/access/analyze-shell-access";
import { createFileAccess } from "../filesystem/access/create-file-access";
import { inspectPathSecurity } from "../security/path/inspect-path-security";
import { createSensitiveReadPolicySnapshot } from "../security/path/sensitive-policy-snapshot";
import { classifySensitivePath, createSensitivePathPolicy } from "../security/path/sensitive-paths";

const environment = { platform: "darwin" as const, home: "/Users/test" };

describe("sensitive path policy", () => {
  it("uses one policy source for TypeScript classification and the Rust projection", () => {
    const policy = createSensitivePathPolicy(environment);
    const snapshot = createSensitiveReadPolicySnapshot([], environment);

    expect(snapshot.deniedSubtrees).toEqual(policy.credentialDirectories);
    expect(snapshot.deniedExactNames).toEqual(policy.credentialFileNames);
    expect(snapshot.deniedNamePrefixes).toEqual(policy.credentialNamePrefixes);
    expect(snapshot.allowedTemplateNames).toEqual(policy.credentialTemplateNames);
  });

  it("allows ordinary env templates but keeps templates inside credential directories sensitive", () => {
    expect(classifySensitivePath("/workspace/.env.example", environment)).toBeNull();
    expect(
      classifySensitivePath(path.join(environment.home, ".ssh", ".env.example"), environment),
    ).toBe("credential");
  });

  it("proposes an ordinary parent subtree but an exact sensitive read", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "omni-consent-"));
    try {
      const ordinary = await inspectPathSecurity(
        path.join(directory, "source.ts"),
        { cwd: "/workspace", workspaceRoot: "/workspace" },
        environment,
      );
      const sensitive = await inspectPathSecurity(
        path.join(directory, ".env"),
        { cwd: "/workspace", workspaceRoot: "/workspace" },
        environment,
      );
      await expect(
        evaluateFilesystemScopePolicy(
          ordinary,
          { cwd: "/workspace", workspaceRoot: "/workspace" },
          "write",
          environment,
        ),
      ).resolves.toMatchObject({
        consentCandidate: {
          capability: { scope: "subtree", access: "read_write" },
          sensitivity: "ordinary",
        },
      });
      await expect(
        evaluateFilesystemScopePolicy(
          sensitive,
          { cwd: "/workspace", workspaceRoot: "/workspace" },
          "read",
          environment,
        ),
      ).resolves.toEqual({
        consentCandidate: {
          capability: { path: sensitive.target, scope: "exact", access: "read" },
          sensitivity: "sensitive",
        },
      });
      const root = await inspectPathSecurity(
        "/",
        { cwd: "/workspace", workspaceRoot: "/workspace" },
        environment,
      );
      await expect(
        evaluateFilesystemScopePolicy(
          root,
          { cwd: "/workspace", workspaceRoot: "/workspace" },
          "read",
          environment,
        ),
      ).resolves.toEqual({});
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects explicit subtree scopes that contain protected boundaries", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "omni-scope-home-"));
    const scopedEnvironment = { ...environment, home };
    try {
      for (const target of ["/", "/private", home]) {
        const inspection = await inspectPathSecurity(
          target,
          { cwd: "/workspace", workspaceRoot: "/workspace" },
          scopedEnvironment,
        );
        await expect(
          evaluateFilesystemScopePolicy(
            inspection,
            { cwd: "/workspace", workspaceRoot: "/workspace" },
            "write",
            scopedEnvironment,
            "subtree",
          ),
        ).resolves.toMatchObject({ denial: { code: "sandbox_scope_too_broad" } });
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("uses the injected host home instead of mutable process environment", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "omni-injected-home-"));
    const canonicalDirectory = await realpath(directory);
    const previousHome = process.env.HOME;
    process.env.HOME = path.join(directory, "untrusted-home");
    try {
      const access = createFileAccess({ parameter: "file_path", access: "read" });
      if (access.kind !== "dynamic") throw new Error("Expected dynamic file access");
      const intent = await access.assess(
        { file_path: path.join(canonicalDirectory, ".ssh", "id_rsa") },
        {
          cwd: "/workspace",
          workspaceId: "a".repeat(64),
          workspaceRoot: "/workspace",
          agentId: "coding",
          toolCallId: "call",
          hostRuntime: { platform: "darwin", home: canonicalDirectory },
        },
      );

      expect(intent.resources).toContainEqual(
        expect.objectContaining({ sensitivity: "sensitive" }),
      );
      expect(intent.controlledConsentCandidates).toEqual([
        {
          capability: {
            path: path.join(canonicalDirectory, ".ssh", "id_rsa"),
            scope: "exact",
            access: "read",
          },
          sensitivity: "sensitive",
        },
      ]);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("fixed workspace boundary", () => {
  it("classifies file, search and shell targets against the workspace instead of execution cwd", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "omni-boundary-"));
    try {
      const root = await realpath(temp);
      const workspaceRoot = path.join(root, "workspace");
      await mkdir(path.join(workspaceRoot, "sub"), { recursive: true });
      await mkdir(path.join(root, "outside"));
      await symlink(workspaceRoot, path.join(root, "linked"));
      const file = createFileAccess({ parameter: "path", access: "read" });
      const search = createSearchAccess({ parameter: "path", execution: "process" });
      if (file.kind !== "dynamic" || search.kind !== "dynamic")
        throw new Error("Expected dynamic access");
      for (const [cwd, target, location] of [
        [path.join(workspaceRoot, "sub"), "../sample.txt", "workspace"],
        [path.join(root, "outside"), "sample.txt", "external"],
        [workspaceRoot, "../outside/sample.txt", "external"],
        [path.join(root, "linked"), "sample.txt", "workspace"],
      ]) {
        const context = {
          cwd: cwd!,
          workspaceRoot,
          workspaceId: "test",
          agentId: "test",
          toolCallId: "test",
          hostRuntime: environment,
        };
        for (const descriptor of [file, search]) {
          const result = await descriptor.assess({ path: target }, context);
          expect(result.resources).toContainEqual(
            expect.objectContaining({ kind: "filesystem", location }),
          );
        }
        const shell = await analyzeShellAccess({ command: `cat ${target}` }, context);
        const resources = [...shell.resources, ...(shell.uncoveredResources ?? [])];
        expect(resources).toContainEqual(expect.objectContaining({ kind: "filesystem", location }));
      }
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});
