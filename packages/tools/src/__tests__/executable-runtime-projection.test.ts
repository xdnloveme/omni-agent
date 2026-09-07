import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProcessToolDefinition } from "@omni-agent/core";
import { afterEach, describe, expect, it } from "vitest";
import { ExecutableRuntimeProjectionResolver } from "../process/executable/executable-runtime-projection-resolver";
import { createHostRuntimeSnapshot } from "../process/executable/host-runtime-snapshot";
import type { PlatformRuntimeDependencyResolver } from "../process/executable/platform/platform-runtime-dependency-resolver";
import { isSystemRuntimePath } from "../process/executable/platform/system-runtime-paths";
import { inferExecutableRuntimeScopes } from "../process/executable/runtime-root-inference";
import { ProcessExecutionPlanner } from "../process/process-execution-planner";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("ExecutableRuntimeProjectionResolver", () => {
  it("rejects a Process Tool that changes the injected execution cwd", async () => {
    const snapshot = createHostRuntimeSnapshot({
      platform: "darwin",
      path: "/usr/bin:/bin",
      home: os.homedir(),
    });
    const tool: ProcessToolDefinition = {
      name: "invalid_process",
      description: "test",
      schema: { type: "object" },
      timeout: { kind: "none" },
      access: { kind: "internal" },
      execution: { kind: "process" },
      createProcessInvocation: () => ({
        command: "/usr/bin/true",
        args: [],
        cwd: "/outside",
        maxOutputBytes: 1024,
      }),
      createToolResult: () => ({ content: [], isError: false }),
    };
    const planner = new ProcessExecutionPlanner(
      new ExecutableRuntimeProjectionResolver(snapshot, []),
      true,
      10_000,
    );

    await expect(
      planner.prepare({
        tool,
        input: {},
        context: { cwd: "/workspace" },
        access: { route: "host" },
        executableRequirements: [],
      }),
    ).rejects.toMatchObject({ code: "process_invocation_invalid" });
  });

  it("bounds runtime dependency inspection before tool execution", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "omni-projection-timeout-"));
    temporaryDirectories.push(root);
    const canonicalRoot = await realpath(root);
    const executable = path.join(canonicalRoot, "tool");
    await writeFile(executable, Buffer.alloc(16), { mode: 0o755 });
    const snapshot = createHostRuntimeSnapshot({
      platform: "darwin",
      path: "/usr/bin:/bin",
      home: os.homedir(),
    });
    const blockingResolver: PlatformRuntimeDependencyResolver = {
      supports: () => true,
      resolve: async (_path, context) =>
        await new Promise((_resolve, reject) => {
          context.signal?.addEventListener("abort", () => reject(context.signal?.reason), {
            once: true,
          });
        }),
    };
    const planner = new ProcessExecutionPlanner(
      new ExecutableRuntimeProjectionResolver(snapshot, [blockingResolver]),
      true,
      1,
    );
    const tool: ProcessToolDefinition = {
      name: "blocking_process",
      description: "test",
      schema: { type: "object" },
      timeout: { kind: "none" },
      access: { kind: "internal" },
      execution: { kind: "process" },
      createProcessInvocation: (_input, context) => ({
        command: executable,
        args: [],
        cwd: context.cwd,
        maxOutputBytes: 1024,
      }),
      createToolResult: () => ({ content: [], isError: false }),
    };

    await expect(
      planner.prepare({
        tool,
        input: {},
        context: { cwd: canonicalRoot },
        access: {
          route: "sandbox",
          policy: {
            mode: "controlled",
            workspaceRoot: canonicalRoot,
            network: { kind: "disabled" },
            read: [],
            write: [],
            protectedWriteRoots: [canonicalRoot],
          },
        },
        executableRequirements: [],
      }),
    ).rejects.toMatchObject({ code: "sandbox_runtime_projection_timeout" });
  });

  it("rejects a relative PATH symlink whose canonical target is outside access scope", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "omni-relative-path-symlink-"));
    temporaryDirectories.push(root);
    const workspace = path.join(root, "workspace");
    const external = path.join(root, "external");
    await Promise.all([mkdir(workspace), mkdir(external)]);
    const target = path.join(external, "tool");
    await writeFile(target, Buffer.alloc(16), { mode: 0o755 });
    await symlink(target, path.join(workspace, "tool"));
    const snapshot = createHostRuntimeSnapshot({
      platform: "darwin",
      path: ".:/usr/bin:/bin",
      home: os.homedir(),
    });
    await expect(
      new ExecutableRuntimeProjectionResolver(snapshot, []).resolve("tool", [], {
        cwd: workspace,
        policy: {
          mode: "controlled",
          workspaceRoot: await realpath(workspace),
          network: { kind: "disabled" },
          read: [],
          write: [],
          protectedWriteRoots: [workspace],
        },
      }),
    ).rejects.toMatchObject({ code: "sandbox_runtime_projection_failed" });
  });

  it("resolves a PATH symlink, package root, and env shebang interpreter", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "omni-runtime-projection-"));
    temporaryDirectories.push(root);
    const bin = path.join(root, "bin");
    const workspace = path.join(root, "workspace");
    const packageRoot = path.join(root, "packages", "tool");
    const script = path.join(packageRoot, "bin", "tool.mjs");
    await Promise.all([
      mkdir(bin),
      mkdir(workspace),
      mkdir(path.dirname(script), { recursive: true }),
    ]);
    await writeFile(path.join(packageRoot, "package.json"), "{}\n");
    await writeFile(script, "#!/usr/bin/env node\n", { mode: 0o755 });
    await symlink(script, path.join(bin, "tool"));
    await symlink("/bin/sh", path.join(bin, "node"));

    const snapshot = createHostRuntimeSnapshot({
      platform: "darwin",
      path: `${bin}:/usr/bin:/bin`,
      home: path.join(root, "home"),
    });
    const resolver = new ExecutableRuntimeProjectionResolver(snapshot, []);
    const result = await resolver.resolve("tool", [], {
      cwd: workspace,
      policy: {
        mode: "controlled",
        workspaceRoot: await realpath(workspace),
        network: { kind: "disabled" as const },
        read: [],
        write: [],
        protectedWriteRoots: [root],
      },
    });

    expect(result.executablePath).toBe(path.join(bin, "tool"));
    expect(result.readScopes).toContainEqual({
      path: await realpath(packageRoot),
      scope: "subtree",
    });
    expect(result.readScopes).toContainEqual({ path: path.join(bin, "node"), scope: "exact" });
    expect(result.readScopes).not.toContainEqual({ path: await realpath(root), scope: "subtree" });
  });

  it("does not require unavailable commands referenced by a shell script", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "omni-shell-candidates-"));
    temporaryDirectories.push(root);
    const bin = path.join(root, "bin");
    const workspace = path.join(root, "workspace");
    await Promise.all([mkdir(bin), mkdir(workspace)]);
    await writeFile(path.join(root, "package.json"), "{}\n");
    await writeFile(
      path.join(bin, "tool"),
      "#!/bin/sh\nif command -v unavailable-helper; then unavailable-helper; fi\n",
      { mode: 0o755 },
    );
    const snapshot = createHostRuntimeSnapshot({
      platform: "darwin",
      path: `${bin}:/usr/bin:/bin`,
      home: path.join(root, "home"),
    });

    await expect(
      new ExecutableRuntimeProjectionResolver(snapshot, []).resolve("tool", [], {
        cwd: workspace,
        policy: {
          mode: "controlled",
          workspaceRoot: await realpath(workspace),
          network: { kind: "disabled" },
          read: [],
          write: [],
          protectedWriteRoots: [workspace],
        },
      }),
    ).resolves.toBeDefined();
  });

  it("rejects an opaque script whose PATH owner would expose a shared temp root", async () => {
    const script = path.join("/tmp", `omni-opaque-${process.pid}-${Date.now()}`);
    temporaryDirectories.push(script);
    await writeFile(script, "#!/bin/sh\n", { mode: 0o755 });
    const snapshot = createHostRuntimeSnapshot({
      platform: "darwin",
      path: "/tmp:/bin:/usr/bin",
      home: os.homedir(),
    });
    const resolver = new ExecutableRuntimeProjectionResolver(snapshot, []);

    await expect(
      resolver.resolve(path.basename(script), [], {
        cwd: "/tmp",
        policy: {
          mode: "controlled",
          workspaceRoot: "/tmp/workspace",
          network: { kind: "disabled" },
          read: [],
          write: [],
          protectedWriteRoots: ["/tmp/workspace"],
        },
      }),
    ).rejects.toMatchObject({ code: "sandbox_runtime_projection_too_broad" });
  });

  it("fails closed for missing commands and a call-wide native image overflow", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "omni-runtime-budget-"));
    temporaryDirectories.push(root);
    const canonicalRoot = await realpath(root);
    const executable = path.join(root, "tool");
    await writeFile(executable, Buffer.alloc(16), { mode: 0o755 });
    const snapshot = createHostRuntimeSnapshot({
      platform: "darwin",
      path: "/bin:/usr/bin",
      home: os.homedir(),
    });
    const context = {
      cwd: canonicalRoot,
      policy: {
        mode: "controlled" as const,
        workspaceRoot: canonicalRoot,
        network: { kind: "disabled" as const },
        read: [],
        write: [],
        protectedWriteRoots: [canonicalRoot],
      },
    };
    await expect(
      new ExecutableRuntimeProjectionResolver(snapshot, []).resolve(
        executable,
        [
          {
            kind: "host_command",
            command: "omni-command-that-does-not-exist",
            cwd: canonicalRoot,
            origin: "shell_command",
          },
        ],
        context,
      ),
    ).rejects.toMatchObject({ code: "process_executable_not_found" });

    const overflowingResolver: PlatformRuntimeDependencyResolver = {
      supports: () => true,
      resolve: async (_path, dependencyContext) => {
        for (let index = 0; index < 129; index += 1) {
          dependencyContext.consumeImageBudget(`/native/image-${index}`);
        }
        return [];
      },
    };
    await expect(
      new ExecutableRuntimeProjectionResolver(snapshot, [overflowingResolver]).resolve(
        executable,
        [],
        context,
      ),
    ).rejects.toMatchObject({ code: "sandbox_runtime_projection_limit" });
  });

  it("uses each native executable as its own Mach-O root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "omni-runtime-shebang-root-"));
    temporaryDirectories.push(root);
    const workspace = path.join(root, "workspace");
    const bin = path.join(root, "bin");
    const script = path.join(bin, "tool");
    const interpreter = path.join(bin, "interpreter");
    await Promise.all([mkdir(workspace), mkdir(bin)]);
    await writeFile(path.join(root, "package.json"), "{}\n");
    await writeFile(script, `#!${interpreter}\n`, { mode: 0o755 });
    await writeFile(interpreter, Buffer.alloc(16), { mode: 0o755 });

    const roots: string[] = [];
    const nativeResolver: PlatformRuntimeDependencyResolver = {
      supports: () => true,
      resolve: async (image, dependencyContext) => {
        roots.push(dependencyContext.rootExecutablePath);
        dependencyContext.consumeImageBudget(image);
        return [];
      },
    };
    const snapshot = createHostRuntimeSnapshot({
      platform: "darwin",
      path: `${bin}:/usr/bin:/bin`,
      home: path.join(root, "home"),
    });
    const context = {
      cwd: workspace,
      policy: {
        mode: "controlled" as const,
        workspaceRoot: await realpath(workspace),
        network: { kind: "disabled" as const },
        read: [],
        write: [],
        protectedWriteRoots: [workspace],
      },
    };
    const resolver = new ExecutableRuntimeProjectionResolver(snapshot, [nativeResolver]);
    await resolver.resolve("tool", [], context);

    expect(roots).toEqual([await realpath(interpreter)]);
    await expect(resolver.resolve(interpreter, [], context)).rejects.toMatchObject({
      code: "sandbox_runtime_projection_failed",
    });
  });

  it("counts shared native images once across executable closures", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "omni-runtime-shared-images-"));
    temporaryDirectories.push(root);
    const workspace = path.join(root, "workspace");
    const bin = path.join(root, "bin");
    await Promise.all([mkdir(workspace), mkdir(bin)]);
    await Promise.all(
      ["first", "second"].map((name) =>
        writeFile(path.join(bin, name), Buffer.alloc(16), { mode: 0o755 }),
      ),
    );
    const sharedResolver: PlatformRuntimeDependencyResolver = {
      supports: () => true,
      resolve: async (_image, dependencyContext) => {
        for (let index = 0; index < 100; index += 1) {
          dependencyContext.consumeImageBudget(`/shared/image-${index}`);
        }
        return [];
      },
    };
    const snapshot = createHostRuntimeSnapshot({
      platform: "darwin",
      path: `${bin}:/usr/bin:/bin`,
      home: path.join(root, "home"),
    });

    await expect(
      new ExecutableRuntimeProjectionResolver(snapshot, [sharedResolver]).resolve(
        "first",
        [
          {
            kind: "host_command",
            command: "second",
            cwd: workspace,
            origin: "shell_command",
          },
        ],
        {
          cwd: workspace,
          policy: {
            mode: "controlled",
            workspaceRoot: await realpath(workspace),
            network: { kind: "disabled" },
            read: [],
            write: [],
            protectedWriteRoots: [workspace],
          },
        },
      ),
    ).resolves.toBeDefined();
  });

  it("does not treat shallow installation prefixes as bounded runtime roots", async () => {
    const snapshot = createHostRuntimeSnapshot({
      platform: "darwin",
      path: "/opt/omni-prefix/bin:/usr/bin:/bin",
      home: os.homedir(),
    });
    await expect(
      inferExecutableRuntimeScopes(
        {
          executablePath: "/opt/omni-prefix/bin/tool",
          canonicalExecutablePath: "/opt/omni-prefix/bin/tool",
          pathEntry: "/opt/omni-prefix/bin",
          lookupSource: "immutable_path",
        },
        snapshot,
        true,
      ),
    ).rejects.toMatchObject({ code: "sandbox_runtime_projection_too_broad" });
    expect(isSystemRuntimePath("/usr/bin/env", "darwin")).toBe(true);
    expect(isSystemRuntimePath("/usr/local/bin/tool", "darwin")).toBe(false);
  });

  it("does not project package roots for native executables", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "omni-native-package-root-"));
    temporaryDirectories.push(root);
    const workspace = path.join(root, "workspace");
    const packageRoot = path.join(root, "package");
    const build = path.join(packageRoot, "build");
    const executable = path.join(build, "tool");
    await Promise.all([mkdir(workspace), mkdir(build, { recursive: true })]);
    await writeFile(path.join(packageRoot, "package.json"), "{}\n");
    await writeFile(executable, Buffer.alloc(16), { mode: 0o755 });
    const snapshot = createHostRuntimeSnapshot({
      platform: "darwin",
      path: `${build}:/usr/bin:/bin`,
      home: path.join(root, "home"),
    });
    const result = await new ExecutableRuntimeProjectionResolver(snapshot, []).resolve("tool", [], {
      cwd: workspace,
      policy: {
        mode: "controlled",
        workspaceRoot: await realpath(workspace),
        network: { kind: "disabled" },
        read: [],
        write: [],
        protectedWriteRoots: [workspace],
      },
    });

    expect(result.readScopes).toContainEqual({ path: executable, scope: "exact" });
    expect(result.readScopes).not.toContainEqual({ path: packageRoot, scope: "subtree" });
  });
});
