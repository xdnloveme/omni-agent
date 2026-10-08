import { ConfigService, createModelService, serveModelExecution } from "@omni-agent/app";
import { copyFile, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
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
      "state-dir": { type: "string" },
      "config-file": { type: "string" },
      "providers-file": { type: "string" },
      "auth-file": { type: "string" },
      "ready-file": { type: "string" },
    },
  });
  for (const key of [
    "socket",
    "agent",
    "state-dir",
    "config-file",
    "providers-file",
    "auth-file",
    "ready-file",
  ] as const) {
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
  const state = resolve(values["state-dir"]!);
  await mkdir(state, { mode: 0o700 });
  await copyFile(resolve(values["providers-file"]!), join(state, "providers.json"));
  await copyFile(resolve(values["config-file"]!), join(state, "config.json"));
  const selection = await new ConfigService({ cwd: state, globalDirectory: state }).resolveModel(
    values.agent!,
  );
  if (!selection) throw new Error("No valid model selection for execution");
  const service = await createModelService({
    cwd: state,
    globalDirectory: state,
    authEnvironment: authEnvironment as Record<string, string>,
  });
  try {
    if (service.diagnostics.length) throw new Error("Model service initialization failed");
    const server = await serveModelExecution(service, selection, resolve(values.socket!));
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
