import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";

const repositoryRoot = resolve(import.meta.dirname, "..");
const temporaryHome = await mkdtemp(join(tmpdir(), "omni-agent-host-verify-"));
let child: ChildProcess | undefined;

try {
  const token = randomBytes(32).toString("base64url");
  child = spawn(process.execPath, ["--import", "tsx", "apps/omni/src/agent-host-entry.ts"], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      HOME: temporaryHome,
      OMNI_AGENT_HOST_TOKEN: token,
      OMNI_AGENT_HOST_PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr = collect(child.stderr!);
  const stdout = collect(child.stdout!);
  const ready = parseReady(await nextLine(child.stdout!));
  const socket = await openWebSocket(`ws://${ready.host}:${ready.port}/`);

  const authenticated = nextMessage(socket);
  socket.send(JSON.stringify({ v: 1, type: "hello", token }));
  assertMessageType(await authenticated, "ready");

  const response = nextMessage(socket);
  socket.send(JSON.stringify({ v: 1, id: "verify-agents", type: "list_agents" }));
  const agentIds = parseAgentIds(await response);
  socket.close();

  const exit = await waitForExit(child);
  if (exit.code !== 0 || exit.signal !== null) {
    throw new Error(`Agent Host exited unexpectedly (${exit.signal ?? exit.code}): ${stderr()}`);
  }
  if (stdout().split("\n").filter(Boolean).length !== 1) {
    throw new Error("Agent Host wrote unexpected stdout records");
  }
  process.stdout.write(
    `${JSON.stringify({ type: "agent_host_verified", version: 1, agents: agentIds })}\n`,
  );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await waitForExit(child).catch(() => undefined);
  }
  await rm(temporaryHome, { recursive: true, force: true });
}

function parseReady(line: string): { readonly host: string; readonly port: number } {
  const value = JSON.parse(line) as Record<string, unknown>;
  if (
    value.type !== "agent_host_ready" ||
    value.version !== 1 ||
    value.host !== "127.0.0.1" ||
    !Number.isInteger(value.port)
  ) {
    throw new Error("Agent Host returned an invalid ready record");
  }
  return { host: value.host, port: value.port as number };
}

function parseAgentIds(message: Record<string, unknown>): readonly string[] {
  const result = message.result as Record<string, unknown> | undefined;
  const agents = result?.agents;
  if (message.type !== "result" || message.id !== "verify-agents" || !Array.isArray(agents)) {
    throw new Error("Agent Host returned an invalid Agent list");
  }
  const ids = agents.map((agent) => (agent as { readonly id?: unknown }).id);
  if (ids.some((id) => typeof id !== "string")) {
    throw new Error("Agent Host returned an invalid Agent descriptor");
  }
  const expected = ["coding", "financial-analysis"];
  if (ids.length !== expected.length || expected.some((id) => !ids.includes(id))) {
    throw new Error("Agent Host did not return the expected built-in Agents");
  }
  return ids as string[];
}

function assertMessageType(message: Record<string, unknown>, type: string): void {
  if (message.type !== type || message.v !== 1) {
    throw new Error(`Agent Host returned an invalid ${type} message`);
  }
}

function openWebSocket(url: string): Promise<WebSocket> {
  return new Promise((resolvePromise, reject) => {
    const socket = new WebSocket(url);
    socket.addEventListener("open", () => resolvePromise(socket), { once: true });
    socket.addEventListener("error", () => reject(new Error("Agent Host connection failed")), {
      once: true,
    });
  });
}

function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for Agent Host")), 5_000);
    socket.addEventListener(
      "message",
      ({ data }) => {
        clearTimeout(timeout);
        try {
          resolvePromise(JSON.parse(String(data)) as Record<string, unknown>);
        } catch (error) {
          reject(error);
        }
      },
      { once: true },
    );
  });
}

function nextLine(stream: Readable): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let buffered = "";
    const timeout = setTimeout(() => finish(new Error("Timed out starting Agent Host")), 10_000);
    const onData = (chunk: Buffer | string) => {
      buffered += chunk.toString();
      const newline = buffered.indexOf("\n");
      if (newline >= 0) finish(undefined, buffered.slice(0, newline));
    };
    const onEnd = () => finish(new Error("Agent Host stopped before becoming ready"));
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
  processHandle: ChildProcess,
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> {
  if (processHandle.exitCode !== null || processHandle.signalCode !== null) {
    return Promise.resolve({ code: processHandle.exitCode, signal: processHandle.signalCode });
  }
  return new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out stopping Agent Host")), 10_000);
    processHandle.once("error", reject);
    processHandle.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolvePromise({ code, signal });
    });
  });
}

function collect(stream: Readable): () => string {
  let value = "";
  stream.setEncoding("utf8").on("data", (chunk: string) => (value += chunk));
  return () => value.trim();
}
