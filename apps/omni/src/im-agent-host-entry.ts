import { homedir } from "node:os";
import { join } from "node:path";
import {
  AGENT_HOST_PROTOCOL_VERSION,
  startAgentHost,
  type AgentHostServer,
} from "@omni-agent/agent-host";
import { type ExtensionSourceLoader } from "@omni-agent/app";
import type { AgentServiceComposition } from "./agent-service-composition";
import { createAgentServiceComposition } from "./agent-service-composition";
import { prepareImAgentHostSecurityProfile } from "./im-agent-host-security";
import { ProcessTerminationController, registerProcessSignals } from "./process-signals";

const termination = new ProcessTerminationController();
const signals = registerProcessSignals((result) => termination.terminate(result));
let host: AgentHostServer | undefined;
let composition: AgentServiceComposition | undefined;
let ready = false;

void run()
  .catch((error) => {
    if (!ready) {
      process.stdout.write(
        `${JSON.stringify({
          type: "agent_host_failed",
          version: AGENT_HOST_PROTOCOL_VERSION,
          code: "host_start_failed",
        })}\n`,
      );
    }
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  })
  .finally(() => signals.dispose());

async function run(): Promise<void> {
  const token = requiredEnvironment("OMNI_AGENT_HOST_TOKEN");
  const agentId = requiredEnvironment("OMNI_IM_AGENT_ID");
  const port = parsePort(process.env.OMNI_AGENT_HOST_PORT);
  const { projectDirectory, stateDirectory, configurationCwd } =
    await prepareImAgentHostSecurityProfile({
      projectDirectory: requiredEnvironment("OMNI_IM_PROJECT_DIRECTORY"),
      stateDirectory: requiredEnvironment("OMNI_IM_STATE_DIRECTORY"),
      agentId,
    });

  composition = await createAgentServiceComposition({
    cwd: projectDirectory,
    configurationDirectory: configurationCwd,
    globalDirectory: stateDirectory,
    resolutionBase: process.argv[1] ?? import.meta.filename,
    agentPackagesDirectory: join(stateDirectory, "agents"),
    extensionSourceLoader: noLocalExtensions,
    interactivePermissions: false,
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
        version: AGENT_HOST_PROTOCOL_VERSION,
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
      throw new AggregateError(failures, "Failed to close IM Agent Host resources");
    }
  }
}

const noLocalExtensions: ExtensionSourceLoader = {
  async load() {
    return { candidates: [], diagnostics: [] };
  },
};

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
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
  return new Promise((resolvePromise) =>
    signal.addEventListener("abort", () => resolvePromise(), { once: true }),
  );
}
