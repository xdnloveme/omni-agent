import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const entryArguments = ["--import", "tsx", "apps/omni/src/agent-host-entry.ts"];

describe("omni-host process entry", () => {
  it("lets the developer verifier manage authentication without exposing its Token", async () => {
    const environment = { ...process.env };
    delete environment.OMNI_AGENT_HOST_TOKEN;
    const result = await runProcess(
      process.execPath,
      ["--import", "tsx", "scripts/verify-agent-host.ts"],
      environment,
    );

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      type: "agent_host_verified",
      version: 1,
      agents: ["coding", "financial-analysis"],
    });
    expect(result.stdout).not.toContain("token");
    expect(result.stderr).toBe("");
  }, 20_000);

  it("fails closed with a machine-readable startup record when its token is missing", async () => {
    const environment = { ...process.env };
    delete environment.OMNI_AGENT_HOST_TOKEN;
    const result = await runProcess(process.execPath, entryArguments, environment);

    expect(result.code).toBe(1);
    expect(result.stdout.trim()).toBe(
      JSON.stringify({ type: "agent_host_failed", version: 1, code: "host_start_failed" }),
    );
    expect(result.stderr).toContain("OMNI_AGENT_HOST_TOKEN is required");
    expect(result.stdout).not.toContain("token");
  }, 15_000);

  it("closes the real Host process cleanly on SIGTERM", async () => {
    await withTemporaryHome(async (temporaryHome) => {
      const child = startProcess({
        ...process.env,
        HOME: temporaryHome,
        OMNI_AGENT_HOST_TOKEN: randomBytes(32).toString("base64url"),
        OMNI_AGENT_HOST_PORT: "0",
      });
      try {
        await expect(nextLine(child.stdout!)).resolves.toContain("agent_host_ready");
        child.kill("SIGTERM");
        await expect(waitForExit(child)).resolves.toMatchObject({ code: 0, signal: null });
      } finally {
        await stopProcess(child);
      }
    });
  }, 20_000);
});

function startProcess(environment: NodeJS.ProcessEnv): ChildProcess {
  return spawn(process.execPath, entryArguments, {
    cwd: repositoryRoot,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function nextLine(stream: Readable): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let buffered = "";
    const timeout = setTimeout(
      () => finish(new Error("Timed out waiting for Host stdout")),
      10_000,
    );
    const onData = (chunk: Buffer | string) => {
      buffered += chunk.toString();
      const newline = buffered.indexOf("\n");
      if (newline >= 0) finish(undefined, buffered.slice(0, newline));
    };
    const onEnd = () => finish(new Error("Host stdout ended before a complete line"));
    const finish = (error?: Error, line?: string) => {
      clearTimeout(timeout);
      stream.off("data", onData);
      stream.off("end", onEnd);
      if (error) reject(error);
      else resolvePromise(line ?? "");
    };
    stream.on("data", onData);
    stream.once("end", onEnd);
  });
}

function waitForExit(
  child: ChildProcess,
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for Host exit")), 10_000);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolvePromise({ code, signal });
    });
  });
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  await waitForExit(child);
}

async function withTemporaryHome(action: (path: string) => Promise<void>): Promise<void> {
  const path = await mkdtemp(join(tmpdir(), "omni-agent-host-test-"));
  try {
    await action(path);
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}

function runProcess(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (code) => resolvePromise({ code, stdout, stderr }));
  });
}
