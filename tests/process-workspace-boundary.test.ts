import { mkdtemp, mkdir, realpath, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToolAccessController } from "../packages/core/src/access/tool-access-controller";
import { createProcessExecutionRuntime } from "../packages/tools/src/process/process-execution-runtime";
import { bashTool } from "../packages/tools/src/shell/bash";

const tool = { ...bashTool, originId: "test", toolIdentity: "test:bash" };
const realSandbox = process.env.OMNI_TEST_SANDBOX === "1";
// An explicitly requested OS check must fail, rather than silently skip or run on the host.
if (realSandbox && process.platform !== "darwin") {
  throw new Error(
    "verify:sandbox requires macOS Seatbelt; Linux containers have a separate boundary.",
  );
}

describe("process workspace boundary", () => {
  let root: string;
  let workspaceRoot: string;
  let outside: string;
  const controller = new ToolAccessController({
    settings: {
      getSettings: async () => ({
        mode: "controlled",
        approvedFilesystemRoots: [],
        approvedNetworkTargets: [],
      }),
      addApprovedAccess: async () => {
        throw new Error("Unexpected permission persistence");
      },
    },
    consent: { request: async () => "deny" },
  });
  const runtime = createProcessExecutionRuntime({
    platform: process.platform,
    path: "/usr/bin:/bin",
    home: os.homedir(),
  });
  const context = (cwd: string) => ({
    cwd,
    workspaceRoot,
    workspaceId: "test",
    agentId: "test",
    toolCallId: "test",
    hostRuntime: runtime.hostRuntime,
    signal: AbortSignal.timeout(15_000),
  });

  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), "omni-workspace-boundary-")));
    workspaceRoot = path.join(root, "workspace");
    outside = path.join(root, "outside");
    await mkdir(path.join(workspaceRoot, "sub"), { recursive: true });
    await mkdir(outside);
    await writeFile(path.join(workspaceRoot, "sample"), "inside");
    await writeFile(path.join(outside, "sample"), "outside");
  });
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function prepare(command: string, platformRuntime = runtime) {
    const executionContext = {
      ...context(path.join(workspaceRoot, "sub")),
      hostRuntime: platformRuntime.hostRuntime,
    };
    const access = await controller.authorize({
      tool,
      input: { command },
      context: executionContext,
    });
    if (access.outcome !== "allowed") throw new Error("Expected authorized process");
    if (!access.grant.processAccess) throw new Error("Expected process access plan");
    expect(access.grant.processAccess).toMatchObject({
      route: "sandbox",
      policy: { workspaceRoot },
    });
    return platformRuntime.planner.prepare({
      tool,
      input: access.grant.input,
      context: executionContext,
      access: access.grant.processAccess,
      executableRequirements: access.grant.executableRequirements,
    });
  }

  it("authorizes parent reads inside the fixed workspace, but denies external cwd and cd targets", async () => {
    for (const [cwd, command, outcome] of [
      [path.join(workspaceRoot, "sub"), "cat ../sample", "allowed"],
      [outside, "cat sample", "denied"],
      [workspaceRoot, `cd '${outside}' && cat sample`, "denied"],
    ] as const) {
      expect(
        (await controller.authorize({ tool, input: { command }, context: context(cwd) })).outcome,
      ).toBe(outcome);
    }
  });

  it("rejects unsupported sandbox platforms without creating a host execution plan", async () => {
    const linux = createProcessExecutionRuntime({
      platform: "linux",
      path: "/usr/bin:/bin",
      home: os.homedir(),
    });
    await expect(prepare("cat ../sample", linux)).rejects.toMatchObject({
      code: "sandbox_unsupported_platform",
    });
  });

  it.skipIf(!realSandbox)(
    "preserves command failure output and enforces the authorized workspace in the OS sandbox",
    async () => {
      const plan = await prepare("cat ../sample 2>/dev/null; printf err >&2; exit 42");
      const output = await runtime.router.run(plan);
      expect(output).toMatchObject({ stdout: "inside", stderr: "err", exitCode: 42, signal: null });
      const result = await bashTool.createToolResult(output);
      expect(result).toMatchObject({
        isError: true,
        meta: { process: { exitCode: 42, signal: null } },
      });
      expect(result.content).toEqual(
        expect.arrayContaining([
          { type: "text", text: "inside" },
          { type: "text", text: "STDERR:\nerr" },
          { type: "text", text: "Exit code: 42" },
        ]),
      );
      // Bypass static target discovery only: the same OS policy must still deny the read.
      const blocked = await runtime.router.run({
        ...plan,
        invocation: { ...plan.invocation, args: ["-c", `cat '${outside}/sample'`] },
      });
      expect(blocked.exitCode).not.toBeNull();
      expect(blocked.exitCode).not.toBe(0);
      expect(blocked.stdout).not.toContain("outside");
      expect(blocked.stderr).toMatch(/Operation not permitted|Permission denied/);
      const blockedWrite = await runtime.router.run({
        ...plan,
        invocation: {
          ...plan.invocation,
          args: ["-c", `printf changed > '${outside}/sample' 2>/dev/null`],
        },
      });
      expect(blockedWrite.exitCode).not.toBeNull();
      expect(blockedWrite.exitCode).not.toBe(0);
      expect(await readFile(path.join(outside, "sample"), "utf8")).toBe("outside");
    },
    30_000,
  );
});
