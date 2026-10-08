import {
  ConfigService,
  createModelService,
  serveModelExecution,
  resolveAgentModel,
} from "@omni-agent/app";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

// Process composition only. Provider protocol and credentials remain owned by Models.
void main().catch(() => {
  // Never print provider exceptions or credentials across the process boundary.
  process.stderr.write("Model execution service failed\n");
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      socket: { type: "string" },
      agent: { type: "string" },
      "configuration-dir": { type: "string" },
      "auth-file": { type: "string" },
      "ready-file": { type: "string" },
    },
  });
  for (const key of ["socket", "agent", "configuration-dir", "auth-file", "ready-file"] as const) {
    if (!values[key]) throw new Error(`--${key} is required`);
  }
  const authFile = resolve(values["auth-file"]!);
  let authEnvironment: unknown;
  try {
    authEnvironment = JSON.parse(await readFile(authFile, "utf8"));
  } finally {
    await unlink(authFile);
  }
  if (
    !authEnvironment ||
    typeof authEnvironment !== "object" ||
    Array.isArray(authEnvironment) ||
    Object.values(authEnvironment).some((value) => typeof value !== "string")
  )
    throw new Error("Invalid authentication environment");
  const configurationDirectory = resolve(values["configuration-dir"]!);
  const service = await createModelService({
    cwd: configurationDirectory,
    globalDirectory: configurationDirectory,
    authEnvironment: authEnvironment as Record<string, string>,
  });
  try {
    if (service.diagnostics.length) throw new Error("Model service initialization failed");
    const { modelSelection } = await resolveAgentModel(
      values.agent!,
      new ConfigService({ cwd: configurationDirectory, globalDirectory: configurationDirectory }),
      service,
    );
    const server = await serveModelExecution(service, modelSelection, resolve(values.socket!));
    const stop = () => server.close();
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    try {
      await writeFile(resolve(values["ready-file"]!), "ready\n", { mode: 0o600, flag: "wx" });
      await server.closed;
    } finally {
      server.close();
      process.off("SIGTERM", stop);
      process.off("SIGINT", stop);
    }
  } finally {
    await service.dispose();
  }
}
