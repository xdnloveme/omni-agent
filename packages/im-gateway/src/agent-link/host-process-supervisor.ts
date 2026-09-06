import { randomBytes } from "node:crypto";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import type { Readable } from "node:stream";
import { AgentHostProtocolClient } from "./protocol-client";

export interface ManagedHostOptions {
  readonly mode: "managed";
  readonly entryPath: string;
  readonly projectDirectory: string;
  readonly stateDirectory: string;
  readonly agentId: string;
}

export interface AttachedHostOptions {
  readonly mode: "attached";
  readonly port: number;
  readonly token: string;
}

export type HostProcessSupervisorOptions = ManagedHostOptions | AttachedHostOptions;
type ManagedChild = ChildProcessByStdio<null, Readable, Readable>;

export class HostProcessSupervisor {
  #client?: AgentHostProtocolClient;
  #child?: ManagedChild;
  #starting?: Promise<AgentHostProtocolClient>;
  #closing = false;
  readonly #crashes: number[] = [];

  constructor(private readonly options: HostProcessSupervisorOptions) {}

  getClient(): Promise<AgentHostProtocolClient> {
    if (this.#closing) return Promise.reject(new Error("Agent Host supervisor is closing"));
    if (this.#client) return Promise.resolve(this.#client);
    this.#starting ??= this.#start().finally(() => {
      this.#starting = undefined;
    });
    return this.#starting;
  }

  async dispose(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    await this.#client?.close().catch(() => undefined);
    this.#client = undefined;
    const child = this.#child;
    this.#child = undefined;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await terminateChild(child);
  }

  async #start(): Promise<AgentHostProtocolClient> {
    if (this.options.mode === "attached") {
      const client = new AgentHostProtocolClient(
        `ws://127.0.0.1:${this.options.port}`,
        this.options.token,
      );
      await client.connect();
      this.#client = client;
      return client;
    }
    this.#assertRestartBudget();
    if (this.#crashes.length > 0) {
      await delay(Math.min(2_000, 250 * 2 ** (this.#crashes.length - 1)));
    }
    const token = randomBytes(32).toString("base64url");
    const entryPath = resolve(this.options.entryPath);
    const arguments_ = [...(entryPath.endsWith(".ts") ? ["--import", "tsx"] : []), entryPath];
    const child = spawn(process.execPath, arguments_, {
      cwd: this.options.projectDirectory,
      env: createAgentHostEnvironment(this.options, token),
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.#child = child;
    child.once("exit", () => {
      if (this.#child === child) this.#child = undefined;
      const client = this.#client;
      if (client) {
        this.#client = undefined;
        void client.close().catch(() => undefined);
      }
      if (!this.#closing) this.#recordCrash();
    });
    child.stderr.pipe(process.stderr);
    let ready: { host: string; port: number };
    try {
      ready = await waitForReady(child);
    } catch (error) {
      await terminateChild(child);
      throw error;
    }
    const client = new AgentHostProtocolClient(`ws://${ready.host}:${ready.port}`, token);
    try {
      await client.connect();
    } catch (error) {
      await terminateChild(child);
      throw error;
    }
    this.#client = client;
    return client;
  }

  #recordCrash(): void {
    const cutoff = Date.now() - 60_000;
    this.#crashes.push(Date.now());
    while ((this.#crashes[0] ?? Infinity) < cutoff) this.#crashes.shift();
  }

  #assertRestartBudget(): void {
    const cutoff = Date.now() - 60_000;
    while ((this.#crashes[0] ?? Infinity) < cutoff) this.#crashes.shift();
    if (this.#crashes.length >= 5) {
      throw new Error("IM Agent Host restart circuit is open after five crashes in one minute");
    }
  }
}

function createAgentHostEnvironment(options: ManagedHostOptions, token: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    SHELL: process.env.SHELL,
    LANG: process.env.LANG,
    PATHEXT: process.env.PATHEXT,
    DEVELOPER_DIR: process.env.DEVELOPER_DIR,
    OMNI_AGENT_HOST_TOKEN: token,
    OMNI_AGENT_HOST_PORT: "0",
    OMNI_IM_PROJECT_DIRECTORY: options.projectDirectory,
    OMNI_IM_STATE_DIRECTORY: options.stateDirectory,
    OMNI_IM_AGENT_ID: options.agentId,
  };
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith("LC_")) environment[name] = value;
  }
  return Object.fromEntries(Object.entries(environment).filter(([, value]) => value !== undefined));
}

async function waitForReady(child: ManagedChild): Promise<{ host: string; port: number }> {
  const lines = createInterface({ input: child.stdout });
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("IM Agent Host did not become ready within 30 seconds"));
    }, 30_000);
    let bytes = 0;
    const cleanup = () => {
      clearTimeout(timer);
      lines.close();
      child.off("exit", onExit);
      child.off("error", onError);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`IM Agent Host exited before ready (${signal ?? code})`));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    child.once("exit", onExit);
    child.once("error", onError);
    lines.on("line", (line) => {
      bytes += Buffer.byteLength(line, "utf8");
      if (bytes > 64 * 1024) {
        cleanup();
        reject(new Error("IM Agent Host readiness output exceeded 64 KiB"));
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        return;
      }
      if (
        isRecord(value) &&
        value.type === "agent_host_ready" &&
        value.host === "127.0.0.1" &&
        typeof value.port === "number"
      ) {
        cleanup();
        resolvePromise({ host: value.host, port: value.port });
      }
    });
  });
}

async function terminateChild(child: ManagedChild): Promise<void> {
  const exited =
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()));
  child.kill("SIGTERM");
  await Promise.race([exited, delay(2_000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await exited;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
