import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { resolveGodotExecutable } from "./godot-executable-resolver";

const HOST_READY_TIMEOUT_MS = 15_000;
const PROCESS_START_TIMEOUT_MS = 15_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;

interface ChildExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export type GameBootstrapTermination =
  | { readonly reason: "game_exited"; readonly exit: ChildExit }
  | { readonly reason: "host_exited"; readonly exit: ChildExit }
  | { readonly reason: "closed" };

export interface GameBootstrapRuntime {
  readonly termination: Promise<GameBootstrapTermination>;
  close(): Promise<void>;
}

export interface GameBootstrapOptions {
  readonly workspaceCwd: string;
  readonly repositoryRoot: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly headlessScene?: string;
}

export async function startGameBootstrap(
  options: GameBootstrapOptions,
): Promise<GameBootstrapRuntime> {
  const environment = { ...(options.environment ?? process.env) };
  const godotExecutable = await resolveGodotExecutable({
    cwd: options.workspaceCwd,
    environment,
  });
  const token = randomBytes(32).toString("base64url");
  const host = spawn(
    process.execPath,
    [
      "--import",
      import.meta.resolve("tsx"),
      join(options.repositoryRoot, "apps/omni/src/agent-host-entry.ts"),
    ],
    {
      cwd: options.workspaceCwd,
      env: {
        ...environment,
        OMNI_AGENT_HOST_TOKEN: token,
        OMNI_AGENT_HOST_PORT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const hostExit = childExit(host);
  const hostDiagnostics = collectBounded(host.stderr!);

  let ready: AgentHostReady;
  try {
    ready = parseAgentHostReady(
      await nextLine(host, host.stdout!, HOST_READY_TIMEOUT_MS, "Agent Host"),
    );
  } catch (error) {
    const diagnostics = hostDiagnostics();
    const startupError = new Error(
      diagnostics ? `Agent Host failed to start: ${diagnostics}` : "Agent Host failed to start.",
      { cause: error },
    );
    return cleanupFailedStartup(startupError, [{ child: host, exit: hostExit }]);
  }

  const gameArguments = options.headlessScene
    ? [
        "--headless",
        "--path",
        join(options.repositoryRoot, "apps/omni-game"),
        options.headlessScene,
      ]
    : ["--path", join(options.repositoryRoot, "apps/omni-game")];
  const game = spawn(godotExecutable, gameArguments, {
    cwd: options.repositoryRoot,
    env: {
      ...environment,
      OMNI_AGENT_HOST_URL: `ws://${ready.host}:${ready.port}/`,
      OMNI_AGENT_HOST_TOKEN: token,
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const gameExit = childExit(game);
  try {
    await waitForSpawn(game, PROCESS_START_TIMEOUT_MS, "Godot");
  } catch (error) {
    return cleanupFailedStartup(error, [
      { child: game, exit: gameExit },
      { child: host, exit: hostExit },
    ]);
  }

  return new RunningGameBootstrap(host, hostExit, game, gameExit);
}

class RunningGameBootstrap implements GameBootstrapRuntime {
  readonly termination: Promise<GameBootstrapTermination>;
  #closingRequested = false;
  #closePromise: Promise<void> | undefined;

  constructor(
    private readonly host: ChildProcess,
    private readonly hostExit: Promise<ChildExit>,
    private readonly game: ChildProcess,
    private readonly gameExit: Promise<ChildExit>,
  ) {
    this.termination = this.monitor();
  }

  close(): Promise<void> {
    this.#closingRequested = true;
    this.#closePromise ??= this.closeOwnedProcesses();
    return this.#closePromise;
  }

  private async monitor(): Promise<GameBootstrapTermination> {
    const first = await Promise.race([
      this.hostExit.then((exit) => ({ source: "host" as const, exit })),
      this.gameExit.then((exit) => ({ source: "game" as const, exit })),
    ]);
    if (this.#closingRequested) {
      await this.close();
      return { reason: "closed" };
    }
    if (first.source === "host") {
      // A successfully authenticated Host exits normally when the Godot client
      // disconnects. The two child exit events can arrive in either order, so
      // give Godot the normal shutdown window before treating Host-first exit
      // observation as a runtime failure.
      if (first.exit.code === 0 && first.exit.signal === null) {
        const gameExit = await settledValueWithin(this.gameExit, SHUTDOWN_TIMEOUT_MS);
        if (gameExit !== undefined) {
          return { reason: "game_exited", exit: gameExit };
        }
      }
      await terminateChild(this.game, this.gameExit);
      return { reason: "host_exited", exit: first.exit };
    }

    await waitForGracefulExitOrTerminate(this.host, this.hostExit);
    return { reason: "game_exited", exit: first.exit };
  }

  private async closeOwnedProcesses(): Promise<void> {
    const failures: unknown[] = [];
    try {
      await terminateChild(this.game, this.gameExit);
    } catch (error) {
      failures.push(error);
    }
    try {
      await terminateChild(this.host, this.hostExit);
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Failed to close game processes");
    }
  }
}

interface AgentHostReady {
  readonly host: "127.0.0.1";
  readonly port: number;
}

export function parseAgentHostReady(line: string): AgentHostReady {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new Error("Agent Host returned invalid startup JSON.", { cause: error });
  }
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 4 ||
    value.type !== "agent_host_ready" ||
    value.version !== 2 ||
    value.host !== "127.0.0.1" ||
    !Number.isInteger(value.port) ||
    (value.port as number) < 1 ||
    (value.port as number) > 65_535
  ) {
    throw new Error("Agent Host returned an invalid startup record.");
  }
  return { host: value.host, port: value.port as number };
}

function childExit(child: ChildProcess): Promise<ChildExit> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolvePromise({ code, signal }));
  });
}

function waitForSpawn(child: ChildProcess, timeoutMs: number, name: string): Promise<void> {
  if (child.pid !== undefined) return Promise.resolve();
  return new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(
      () => finish(new Error(`${name} did not start in time.`)),
      timeoutMs,
    );
    const onSpawn = () => finish();
    const onError = (error: Error) => finish(error);
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      child.off("spawn", onSpawn);
      child.off("error", onError);
      if (error) reject(error);
      else resolvePromise();
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

function nextLine(
  child: ChildProcess,
  stream: Readable,
  timeoutMs: number,
  name: string,
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let buffered = "";
    const timeout = setTimeout(
      () => finish(new Error(`${name} did not become ready in time.`)),
      timeoutMs,
    );
    const onData = (chunk: Buffer | string) => {
      buffered += chunk.toString();
      const newline = buffered.indexOf("\n");
      if (newline >= 0) finish(undefined, buffered.slice(0, newline));
    };
    const onEnd = () => finish(new Error(`${name} stopped before becoming ready.`));
    const onError = (error: Error) => finish(error);
    const finish = (error?: Error, line?: string) => {
      clearTimeout(timeout);
      stream.off("data", onData);
      stream.off("end", onEnd);
      child.off("error", onError);
      if (error) reject(error);
      else resolvePromise(line ?? "");
    };
    stream.on("data", onData);
    stream.once("end", onEnd);
    child.once("error", onError);
  });
}

async function waitForGracefulExitOrTerminate(
  child: ChildProcess,
  exit: Promise<ChildExit>,
): Promise<void> {
  if (isStopped(child)) return;
  const completed = await settlesWithin(exit, SHUTDOWN_TIMEOUT_MS);
  if (!completed) await terminateChild(child, exit);
}

async function terminateChild(child: ChildProcess, exit: Promise<ChildExit>): Promise<void> {
  if (child.pid === undefined) {
    await exit.catch(() => undefined);
    return;
  }
  if (isStopped(child)) {
    await exit;
    return;
  }
  child.kill("SIGTERM");
  if (await settlesWithin(exit, SHUTDOWN_TIMEOUT_MS)) return;
  child.kill("SIGKILL");
  if (!(await settlesWithin(exit, SHUTDOWN_TIMEOUT_MS))) {
    throw new Error("Child process did not stop after SIGKILL.");
  }
}

function settlesWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(() => resolvePromise(false), timeoutMs);
    void promise.then(
      () => {
        clearTimeout(timeout);
        resolvePromise(true);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

async function cleanupFailedStartup(
  startupError: unknown,
  resources: readonly { readonly child: ChildProcess; readonly exit: Promise<ChildExit> }[],
): Promise<never> {
  const cleanupFailures: unknown[] = [];
  for (const resource of resources) {
    try {
      await terminateChild(resource.child, resource.exit);
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  if (cleanupFailures.length > 0) {
    throw new AggregateError(
      [startupError, ...cleanupFailures],
      "Game bootstrap failed and one or more child processes could not be cleaned up",
      { cause: startupError },
    );
  }
  throw startupError;
}

function settledValueWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  return new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(() => resolvePromise(undefined), timeoutMs);
    void promise.then(
      (value) => {
        clearTimeout(timeout);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function collectBounded(stream: Readable): () => string {
  let value = "";
  stream.setEncoding("utf8").on("data", (chunk: string) => {
    value = `${value}${chunk}`.slice(-MAX_DIAGNOSTIC_BYTES);
  });
  return () => value.trim();
}

function isStopped(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
