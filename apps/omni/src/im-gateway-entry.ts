import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ImGateway, loadGatewayConfig } from "@omni-agent/im-gateway";
import { ProcessTerminationController, registerProcessSignals } from "./process-signals";

const termination = new ProcessTerminationController();
const signals = registerProcessSignals((result) => termination.terminate(result), 10_000);
let gateway: ImGateway | undefined;

void run()
  .catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  })
  .finally(() => signals.dispose());

async function run(): Promise<void> {
  const configPath =
    process.env.OMNI_IM_CONFIG ?? join(homedir(), ".omni-agent", "im", "config.json");
  const config = await loadGatewayConfig(configPath);
  gateway = await ImGateway.create(config, {
    managedHostEntryPath: managedHostEntryPath(import.meta.filename),
  });
  const { activeBots } = await gateway.start();
  process.stdout.write(
    `${JSON.stringify({ type: "im_gateway_ready", version: 1, bots: activeBots })}\n`,
  );
  await waitForAbort(termination.signal);
  await gateway.stop();
}

function managedHostEntryPath(entryPath: string): string {
  return join(
    dirname(entryPath),
    entryPath.endsWith(".ts") ? "im-agent-host-entry.ts" : "im-host-entry.js",
  );
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolvePromise) =>
    signal.addEventListener("abort", () => resolvePromise(), { once: true }),
  );
}
