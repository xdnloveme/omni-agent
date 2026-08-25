import { resolve } from "node:path";
import { startGameBootstrap } from "./game-bootstrap";
import { ProcessTerminationController, registerProcessSignals } from "../process-signals";

const repositoryRoot = resolve(import.meta.dirname, "../../../..");
const termination = new ProcessTerminationController();
const signals = registerProcessSignals((result) => termination.terminate(result));

void run()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => signals.dispose());

async function run(): Promise<void> {
  const runtime = await startGameBootstrap({
    workspaceCwd: process.cwd(),
    repositoryRoot,
    environment: process.env,
  });
  const first = await Promise.race([
    runtime.termination.then((result) => ({ type: "runtime" as const, result })),
    waitForAbort(termination.signal).then(() => ({ type: "signal" as const })),
  ]);
  if (first.type === "signal") {
    await runtime.close();
    await runtime.termination;
    return;
  }
  if (first.result.reason === "host_exited") {
    throw new Error("Agent Host stopped before the game closed.");
  }
  if (
    first.result.reason === "game_exited" &&
    (first.result.exit.code !== 0 || first.result.exit.signal !== null)
  ) {
    throw new Error("Godot exited unexpectedly.");
  }
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolvePromise) => {
    signal.addEventListener("abort", () => resolvePromise(), { once: true });
  });
}
