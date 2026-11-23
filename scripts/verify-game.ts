import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { AgentServiceAccessConsentBroker } from "../packages/app/src/index";

const repositoryRoot = resolve(import.meta.dirname, "..");
const temporaryHome = await mkdtemp(join(tmpdir(), "omni-game-verify-"));
const workspaceDirectory = join(temporaryHome, "workspace");
const environment: NodeJS.ProcessEnv = {
  ...process.env,
  HOME: temporaryHome,
  // This check opens Sessions but never executes a model request.
  OMNI_GAME_VERIFY_API_KEY: "local-session-fixture",
};
delete environment.OMNI_AGENT_HOST_TOKEN;
delete environment.OMNI_AGENT_HOST_URL;
let runtime: Awaited<ReturnType<typeof startGameBootstrap>> | undefined;
let failure: unknown;

try {
  // Isolate both configuration layers. HOME alone still loads the repository's
  // omni.config.json and can select a developer-specific provider or extension.
  await mkdir(workspaceDirectory);
  await writeFile(
    join(workspaceDirectory, "omni.config.json"),
    JSON.stringify({
      model: { vendorId: "game-verification", connectionId: "default", modelId: "session-only" },
    }),
  );
  await writeFile(
    join(workspaceDirectory, "omni.providers.json"),
    JSON.stringify({
      version: 1,
      vendors: [
        {
          id: "game-verification",
          displayName: "Session verification",
          connections: [
            {
              id: "default",
              displayName: "Session verification",
              providerId: "game-verification",
              baseUrl: "http://127.0.0.1:1/v1",
              envVars: ["OMNI_GAME_VERIFY_API_KEY"],
              protocol: "openai-completions",
              models: [{ id: "session-only", contextWindow: 32000, maxTokens: 4096 }],
            },
          ],
        },
      ],
    }),
  );
  const godot = await resolveGodotExecutable({ cwd: repositoryRoot, environment });
  const importExit = await runProcess(godot, [
    "--headless",
    "--editor",
    "--path",
    join(repositoryRoot, "apps/omni-game"),
    "--import",
  ]);
  if (importExit !== 0) throw new Error("Godot asset import failed");

  const protocolExit = await runProcess(godot, [
    "--headless",
    "--path",
    join(repositoryRoot, "apps/omni-game"),
    "--script",
    "res://tests/protocol_harness.gd",
  ]);
  if (protocolExit !== 0) throw new Error("Godot Protocol v2 harness failed");

  for (const harness of [
    "rest_appearance_harness",
    "unequipped_ladder_harness",
    "character_locomotion_harness",
  ]) {
    const exit = await runProcess(godot, [
      "--headless",
      "--path",
      join(repositoryRoot, "apps/omni-game"),
      "--script",
      `res://tests/${harness}.gd`,
    ]);
    if (exit !== 0) throw new Error(`Godot ${harness} failed`);
  }

  const worldExit = await runProcess(godot, [
    "--headless",
    // Run the physics-step traversal suite with a deterministic, unthrottled clock.
    "--fixed-fps",
    "60",
    "--path",
    join(repositoryRoot, "apps/omni-game"),
    "res://tests/WorkshopWorldHarness.tscn",
  ]);
  if (worldExit !== 0) throw new Error("Godot WorkshopWorld harness failed");

  for (const agentId of ["coding", "financial-analysis"]) {
    const exit = await runProcess(godot, [
      "--headless",
      "--fixed-fps",
      "60",
      "--path",
      join(repositoryRoot, "apps/omni-game"),
      "res://tests/CharacterMotionHarness.tscn",
      "--",
      `--presentation=res://resources/characters/${agentId}.tres`,
    ]);
    if (exit !== 0) throw new Error(`Godot ${agentId} motion regression failed`);
  }

  const workExit = await runProcess(godot, [
    "--headless",
    "--path",
    join(repositoryRoot, "apps/omni-game"),
    "res://tests/WorkshopWorkActivityHarness.tscn",
  ]);
  if (workExit !== 0) throw new Error("Godot Workshop work activity harness failed");

  const occlusionExit = await runProcess(godot, [
    "--headless",
    "--path",
    join(repositoryRoot, "apps/omni-game"),
    "res://tests/TraversalOcclusionHarness.tscn",
  ]);
  if (occlusionExit !== 0) throw new Error("Godot Workshop occlusion harness failed");

  const cameraExit = await runProcess(godot, [
    "--headless",
    "--path",
    join(repositoryRoot, "apps/omni-game"),
    "res://tests/WorkshopCameraHarness.tscn",
  ]);
  if (cameraExit !== 0) throw new Error("Godot Workshop camera harness failed");

  const displayExit = await runProcess(godot, [
    "--headless",
    "--path",
    join(repositoryRoot, "apps/omni-game"),
    "res://tests/DisplayHarness.tscn",
  ]);
  if (displayExit !== 0) throw new Error("Godot display layout harness failed");

  await verifyDeterministicScene(
    godot,
    "res://tests/ClientLifecycleHarness.tscn",
    "AgentHostClient lifecycle",
  );
  const controllerExit = await runProcess(godot, [
    "--headless",
    "--path",
    join(repositoryRoot, "apps/omni-game"),
    "res://tests/ControllerLifecycleHarness.tscn",
  ]);
  if (controllerExit !== 0) throw new Error("Godot Controller lifecycle harness failed");
  const conversationExit = await runProcess(godot, [
    "--headless",
    "--path",
    join(repositoryRoot, "apps/omni-game"),
    "res://tests/TaskPanelHarness.tscn",
  ]);
  if (conversationExit !== 0) throw new Error("Godot conversation presentation harness failed");
  await verifyDeterministicScene(godot, "res://tests/WorkshopFlowHarness.tscn", "Workshop flow");
  await verifyDeterministicScene(
    godot,
    "res://tests/PermissionFlowHarness.tscn",
    "Workshop permission lifecycle",
  );
  await verifyDeterministicScene(
    godot,
    "res://tests/CharacterInfoHarness.tscn",
    "Character information",
  );
  if (process.argv.includes("--visual")) {
    await verifyDeterministicScene(
      godot,
      "res://tests/CharacterSelectionHarness.tscn",
      "Scene-based companion selection",
      { graphical: true, agentIds: ["coding", "financial-analysis"], timeoutMs: 60_000 },
    );
    for (const agentId of ["coding", "financial-analysis"]) {
      await verifyDeterministicScene(
        godot,
        "res://tests/WorkshopProductionArtHarness.tscn",
        `Production artwork through Main (${agentId})`,
        { graphical: true, agentId, timeoutMs: 60_000 },
      );
    }
  }

  runtime = await startGameBootstrap({
    workspaceCwd: workspaceDirectory,
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
      environment: "workshop",
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
  timeoutMs = 30_000,
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
    }, timeoutMs);
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

async function verifyDeterministicScene(
  godot: string,
  scene: string,
  label: string,
  options: { graphical?: boolean; agentId?: string; agentIds?: string[]; timeoutMs?: number } = {},
): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  const host = await startAgentHost({
    service: deterministicService(options.agentIds ?? [options.agentId ?? "fixture"]),
    token,
  });
  let failure: unknown;
  try {
    const exit = await runProcess(
      godot,
      [
        ...(options.graphical ? [] : ["--headless"]),
        "--path",
        join(repositoryRoot, "apps/omni-game"),
        scene,
      ],
      {
        ...environment,
        OMNI_AGENT_HOST_URL: `ws://${host.address.host}:${host.address.port}/`,
        OMNI_AGENT_HOST_TOKEN: token,
      },
      options.timeoutMs,
    );
    if (exit !== 0) throw new Error(`Godot ${label} harness failed`);
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
        : new AggregateError([failure, error], `${label} verification cleanup failed`, {
            cause: failure,
          });
  }
  if (failure !== undefined) throw failure;
}

function deterministicService(agentIds: readonly string[]): AgentServicePort {
  const permissions = new AgentServiceAccessConsentBroker();
  let permissionRace: AbortController | undefined;
  return {
    subscribePermissions: (sink) => permissions.subscribe(sink),
    resolvePermission: (id, decision) => {
      // Settle the real broker after the user submits but before Host resolution.
      // This reproduces an expired/cancelled permission without timer races.
      permissionRace?.abort();
      permissionRace = undefined;
      return permissions.resolve(id, decision);
    },
    async listAgents() {
      return agentIds.map((agentId) => ({
        id: agentId,
        displayName: "Fixture Agent",
        description: "Deterministic verification fixture",
        packageName: "@omni-agent/fixture",
        packageVersion: "1.0.0",
      }));
    },
    async openSession({ agentId, sessionId }) {
      return { agentId, sessionId: sessionId ?? "fixture-session" };
    },
    async createSession({ agentId }) {
      return { agentId, sessionId: "fixture-session-new" };
    },
    async closeSession() {},
    run(request, signal) {
      if (request.input.text === "permission-race") {
        permissionRace = new AbortController();
        signal = AbortSignal.any([permissionRace.signal, ...(signal ? [signal] : [])]);
      }
      return deterministicRun(request, permissions, signal);
    },
    async dispose() {},
  };
}

async function* deterministicRun(
  request: AgentServiceRunRequest,
  permissions: AgentServiceAccessConsentBroker,
  signal?: AbortSignal,
): AsyncIterable<AgentServiceEvent> {
  yield { type: "started", requestId: request.requestId, sessionId: request.sessionId };
  if (["permissions", "permission-race"].includes(request.input.text)) {
    const decisions = await Promise.all(
      ["first", "second"].map((label) =>
        permissions.request(
          {
            toolCallId: `${request.requestId}-${label}`,
            workspaceId: "verification",
            agentId: request.agentId,
            toolName: "file_read",
            purpose: label,
            scopes: [{ path: `/fixture/${label}`, scope: "exact", access: "read" }],
            targets: [],
          },
          signal,
        ),
      ),
    );
    if (signal?.aborted) {
      yield { type: "cancelled" };
      return;
    }
    yield {
      type: "final_response",
      text: decisions
        .map((decision) => (typeof decision === "string" ? decision : decision.decision))
        .join(","),
    };
    yield { type: "completed" };
    return;
  }
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
