import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startGameBootstrap } from "../apps/omni/src/game/game-bootstrap";
import { resolveGodotExecutable } from "../apps/omni/src/game/godot-executable-resolver";
import { startAgentHost } from "../packages/agent-host/src/index";
import type {
  AgentServiceEvent,
  AgentServicePort,
  AgentServiceRunRequest,
} from "../packages/app/src/index";

const repositoryRoot = resolve(import.meta.dirname, "..");
const temporaryHome = await mkdtemp(join(tmpdir(), "omni-game-verify-"));
const environment: NodeJS.ProcessEnv = {
  ...process.env,
  HOME: temporaryHome,
  // The composition harness opens a Session but never starts a model request.
  // A synthetic value keeps the check deterministic and independent of developer credentials.
  ARK_AGENT_PLAN_API_KEY: "omni-verification-placeholder",
};
delete environment.OMNI_AGENT_HOST_TOKEN;
delete environment.OMNI_AGENT_HOST_URL;
let runtime: Awaited<ReturnType<typeof startGameBootstrap>> | undefined;
let failure: unknown;

try {
  const godot = await resolveGodotExecutable({ cwd: repositoryRoot, environment });
  const importExit = await runProcess(godot, [
    "--headless",
    "--editor",
    "--quit",
    "--path",
    join(repositoryRoot, "apps/omni-game"),
  ]);
  if (importExit !== 0) throw new Error("Godot project import failed");
  const protocolExit = await runProcess(godot, [
    "--headless",
    "--path",
    join(repositoryRoot, "apps/omni-game"),
    "--script",
    "res://tests/protocol_harness.gd",
  ]);
  if (protocolExit !== 0) throw new Error("Godot Protocol v2 harness failed");

  await verifyClientLifecycle(godot);

  runtime = await startGameBootstrap({
    workspaceCwd: repositoryRoot,
    repositoryRoot,
    environment,
    headlessScene: "res://tests/RealHostHarness.tscn",
  });
  const result = await withTimeout(runtime.termination, 30_000);
  if (result.reason !== "game_exited" || result.exit.code !== 0 || result.exit.signal !== null) {
    throw new Error(`Godot Agent Host harness exited unexpectedly: ${JSON.stringify(result)}`);
  }
  process.stdout.write(
    `${JSON.stringify({
      type: "godot_agent_host_client_verified",
      version: 2,
      agents: ["coding", "financial-analysis"],
    })}\n`,
  );
} catch (error) {
  failure = error;
} finally {
  const cleanupFailures: unknown[] = [];
  try {
    await runtime?.close();
  } catch (error) {
    cleanupFailures.push(error);
  }
  try {
    await rm(temporaryHome, { recursive: true, force: true });
  } catch (error) {
    cleanupFailures.push(error);
  }
  if (cleanupFailures.length > 0) {
    failure = new AggregateError(
      failure === undefined ? cleanupFailures : [failure, ...cleanupFailures],
      "Godot verification cleanup failed",
      failure === undefined ? undefined : { cause: failure },
    );
  }
}

if (failure !== undefined) {
  process.stderr.write(`${failure instanceof Error ? failure.message : String(failure)}\n`);
  process.exitCode = 1;
}

function runProcess(
  command: string,
  args: readonly string[],
  processEnvironment: NodeJS.ProcessEnv = environment,
): Promise<number | null> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: processEnvironment,
      stdio: ["ignore", "inherit", "inherit"],
    });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 30_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (timedOut) reject(new Error("Godot harness timed out"));
      else resolvePromise(code);
    });
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(() => reject(new Error("Godot verification timed out")), timeoutMs);
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

async function verifyClientLifecycle(godot: string): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  const host = await startAgentHost({ service: deterministicService(), token });
  let failure: unknown;
  try {
    const exit = await runProcess(
      godot,
      [
        "--headless",
        "--path",
        join(repositoryRoot, "apps/omni-game"),
        "res://tests/ClientLifecycleHarness.tscn",
      ],
      {
        ...environment,
        OMNI_AGENT_HOST_URL: `ws://${host.address.host}:${host.address.port}/`,
        OMNI_AGENT_HOST_TOKEN: token,
      },
    );
    if (exit !== 0) throw new Error("Godot AgentHostClient lifecycle harness failed");
    await withTimeout(host.termination, 10_000);
  } catch (error) {
    failure = error;
  }
  try {
    await host.close();
  } catch (error) {
    failure =
      failure === undefined
        ? error
        : new AggregateError([failure, error], "Client lifecycle verification cleanup failed", {
            cause: failure,
          });
  }
  if (failure !== undefined) throw failure;
}

function deterministicService(): AgentServicePort {
  return {
    async listAgents() {
      return [
        {
          id: "fixture",
          displayName: "Fixture Agent",
          description: "Deterministic verification fixture",
          packageName: "@omni-agent/fixture",
          packageVersion: "1.0.0",
        },
      ];
    },
    async openSession({ agentId, sessionId }) {
      return { agentId, sessionId: sessionId ?? "fixture-session" };
    },
    async createSession({ agentId }) {
      return { agentId, sessionId: "fixture-session" };
    },
    async closeSession() {},
    run(request, signal) {
      return deterministicRun(request, signal);
    },
    async dispose() {},
  };
}

async function* deterministicRun(
  request: AgentServiceRunRequest,
  signal?: AbortSignal,
): AsyncIterable<AgentServiceEvent> {
  yield { type: "started", requestId: request.requestId, sessionId: request.sessionId };
  if (request.input.text === "complete") {
    yield { type: "text_delta", text: "partial" };
    yield { type: "final_response", text: "complete" };
    yield { type: "completed" };
    return;
  }
  await waitForAbort(signal);
  yield { type: "cancelled" };
}

function waitForAbort(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolvePromise) => {
    signal?.addEventListener("abort", () => resolvePromise(), { once: true });
  });
}
