import { homedir } from "node:os";
import { join } from "node:path";
import { startAgentHost, type AgentHostServer } from "@omni-agent/agent-host";
import type { AgentHostComposition } from "./agent-host-composition";
import { createAgentHostComposition } from "./agent-host-composition";
import { ProcessTerminationController, registerProcessSignals } from "./process-signals";

const termination = new ProcessTerminationController();
const signals = registerProcessSignals((result) => termination.terminate(result));
let host: AgentHostServer | undefined;
let composition: AgentHostComposition | undefined;
let ready = false;

void run()
  .catch((error) => {
    if (!ready) {
      process.stdout.write(
        `${JSON.stringify({ type: "agent_host_failed", version: 2, code: "host_start_failed" })}\n`,
      );
    }
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  })
  .finally(() => signals.dispose());

async function run(): Promise<void> {
  const token = process.env.OMNI_AGENT_HOST_TOKEN;
  if (!token) throw new Error("OMNI_AGENT_HOST_TOKEN is required");
  const port = parsePort(process.env.OMNI_AGENT_HOST_PORT);
  const globalDirectory = join(homedir(), ".omni-agent");
  composition = await createAgentHostComposition({
    cwd: process.cwd(),
    globalDirectory,
    resolutionBase: process.argv[1] ?? import.meta.filename,
    agentPackagesDirectory: join(globalDirectory, "agents"),
    hostRuntime: {
      platform: process.platform,
      path: process.env.PATH ?? "",
      pathExt: process.env.PATHEXT,
      home: homedir(),
      developerDirectory: process.env.DEVELOPER_DIR,
    },
  });
  try {
    host = await startAgentHost({ service: composition.service, token, port });
    ready = true;
    process.stdout.write(
      `${JSON.stringify({
        type: "agent_host_ready",
        version: 2,
        host: host.address.host,
        port: host.address.port,
      })}\n`,
    );
    await Promise.race([host.termination, waitForAbort(termination.signal)]);
  } finally {
    const failures: unknown[] = [];
    try {
      await host?.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      await composition.dispose();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Failed to close Agent Host process resources");
    }
  }
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("OMNI_AGENT_HOST_PORT must be an integer from 0 to 65535");
  }
  return port;
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}
