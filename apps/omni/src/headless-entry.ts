import { assertRunDeadline } from "@omni-agent/core";
import { writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  createLocalTraceQuery,
  connectModelExecution,
  type AgentModelService,
  ExecutionSettingsRepository,
  ExecutionSettingsService,
  resolveWorkspaceContext,
  type AgentServiceSession,
} from "@omni-agent/app";
import { TraceStorageLayout } from "@omni-agent/app/trace-storage";
import { runHeadless, type HeadlessOutcome } from "@omni-agent/cli";
import {
  createAgentServiceComposition,
  type AgentServiceComposition,
} from "./agent-service-composition";
import { ProcessTerminationController, registerProcessSignals } from "./process-signals";

const termination = new ProcessTerminationController();
const signals = registerProcessSignals(
  (result) => {
    diagnostic("abort.requested");
    termination.terminate(result);
    diagnostic("abort.dispatched");
  },
  undefined,
  (event) => diagnostic(event.type, event),
);

function diagnostic(phase: string, details: object = {}): void {
  try {
    // Synchronous stderr survives immediate signal exit; never include prompts or credentials.
    writeSync(
      2,
      JSON.stringify({
        ...details,
        type: "headless_diagnostic",
        timestamp: new Date().toISOString(),
        monotonicMs: performance.now(),
        pid: process.pid,
        phase,
      }) + "\n",
    );
  } catch {
    /* Diagnostics cannot change shutdown behavior. */
  }
}
void main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => signals.dispose());

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      cwd: { type: "string", default: process.cwd() },
      agent: { type: "string", default: "coding" },
      "input-file": { type: "string" },
      "deadline-at-ms": { type: "string" },
      "config-file": { type: "string" },
      "providers-file": { type: "string" },
      "model-channel": { type: "string" },
      "output-dir": { type: "string" },
      "confirm-unrestricted": { type: "boolean", default: false },
    },
  });
  if (!values["confirm-unrestricted"])
    throw new Error("Headless execution requires --confirm-unrestricted");
  for (const name of ["input-file", "config-file", "output-dir"] as const) {
    if (!values[name]) throw new Error(`--${name} is required`);
  }
  if (Boolean(values["providers-file"]) === Boolean(values["model-channel"]))
    throw new Error("Exactly one of --providers-file or --model-channel is required");
  const deadlineAtMs =
    values["deadline-at-ms"] === undefined ? undefined : Number(values["deadline-at-ms"]);
  if (values["deadline-at-ms"]?.trim() === "")
    throw new Error("--deadline-at-ms must not be empty");
  assertRunDeadline(deadlineAtMs);
  const outputDirectory = resolve(values["output-dir"]!);
  const input = await readFile(resolve(values["input-file"]!), "utf8");
  if (!input.trim()) throw new Error("Headless input must not be empty");
  await mkdir(outputDirectory, { recursive: true });
  const requestId = randomUUID();
  await writeArtifact("request.json", { version: 1, requestId, agentId: values.agent });
  const globalDirectory = join(outputDirectory, "state");
  let remoteModelService: AgentModelService | undefined;
  let session: AgentServiceSession | undefined;
  let composition: AgentServiceComposition | undefined;
  let outcome: HeadlessOutcome;
  try {
    // Never apply execution settings to existing state, including another headless attempt.
    await mkdir(globalDirectory, { mode: 0o700 });
    await copyFile(resolve(values["config-file"]!), join(globalDirectory, "config.json"));
    if (values["providers-file"])
      await copyFile(resolve(values["providers-file"]), join(globalDirectory, "providers.json"));
    if (values["model-channel"])
      remoteModelService = await connectModelExecution(
        resolve(values["model-channel"]),
        termination.signal,
      );
    const workspace = await resolveWorkspaceContext(values.cwd);
    await new ExecutionSettingsService(new ExecutionSettingsRepository(globalDirectory)).setMode(
      workspace.id,
      values.agent,
      "unrestricted",
    );
    composition = await createAgentServiceComposition({
      cwd: workspace.root,
      modelService: remoteModelService,
      globalDirectory,
      traceEnabled: true,
      resolutionBase: import.meta.filename,
      agentPackagesDirectory: join(globalDirectory, "agents"),
      hostRuntime: {
        platform: process.platform,
        path: process.env.PATH ?? "",
        pathExt: process.env.PATHEXT,
        home: homedir(),
        developerDirectory: process.env.DEVELOPER_DIR,
      },
    });
    if (composition.modelDiagnostics.length > 0) {
      throw new Error(
        `Model initialization diagnostics: ${composition.modelDiagnostics.map((item) => item.code).join(", ")}`,
      );
    }
    outcome = await runHeadless({
      service: composition.service,
      agentId: values.agent,
      requestId,
      input,
      signal: termination.signal,
      deadlineAtMs,
      async onSession(created) {
        session = created;
        await writeArtifact("started.json", { version: 1, requestId, ...created });
      },
      onLifecycle: (phase) => diagnostic(phase),
      onEvent(event) {
        process.stdout.write(`${JSON.stringify({ version: 1, type: "event", event })}\n`);
      },
    });
    diagnostic("run.settled", { status: outcome.status });
  } catch (error) {
    diagnostic("run.failed");
    outcome = {
      status: "failed",
      code: "headless_execution_failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  // Service disposal drains native Trace; CLI owns Session close, Apps owns resource disposal.
  try {
    diagnostic("service.dispose.started");
    if (composition) await composition.dispose();
    else await remoteModelService?.dispose();
    diagnostic("service.dispose.completed");
  } catch (error) {
    outcome = {
      status: "failed",
      code: "headless_cleanup_failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  let trace: Record<string, unknown> = { integrity: "missing" };
  if (session) {
    try {
      diagnostic("trace.query.started");
      const runs = await createLocalTraceQuery(globalDirectory, session.agentId).runs(
        session.sessionId,
      );
      diagnostic("trace.query.completed");
      const run = runs.length === 1 ? runs[0] : undefined;
      if (run) {
        const expected = outcome.status === "failed" ? "error" : outcome.status;
        trace = {
          integrity: run.summary?.capture?.degraded
            ? "degraded"
            : run.completedAt !== undefined && run.status === expected
              ? "complete"
              : "incomplete",
          runId: run.runId,
          status: run.status,
          directory: new TraceStorageLayout(globalDirectory, session.agentId).runRoot(
            session.sessionId,
            run.runId,
          ),
          replayFile: new TraceStorageLayout(globalDirectory, session.agentId).replayPath(
            session.sessionId,
            run.runId,
          ),
          lastTurnUsage: run.summary?.usage ?? null,
        };
      } else if (runs.length > 1) trace = { integrity: "ambiguous", runCount: runs.length };
    } catch (error) {
      trace = {
        integrity: "unreadable",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
  // Completed describes an Agent Run; evaluation reward belongs to the external verifier.
  const result = { version: 1, requestId, ...session, ...outcome, trace };
  diagnostic("result.write.started");
  await writeArtifact("result.json", result);
  diagnostic("result.write.completed");
  process.stdout.write(`${JSON.stringify({ type: "result", ...result })}\n`);
  process.exitCode = outcome.status === "completed" ? 0 : outcome.status === "cancelled" ? 130 : 1;

  async function writeArtifact(name: string, value: unknown): Promise<void> {
    await writeFile(join(outputDirectory, name), `${JSON.stringify(value, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  }
}
