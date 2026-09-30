import { ConfigService, createModelService, serveModelExecution } from "@omni-agent/app";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
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
      "ready-file": { type: "string" },
    },
  });
  for (const key of [
    "socket",
    "agent",
    "state-dir",
    "config-file",
    "providers-file",
    "ready-file",
  ] as const) {
    if (!values[key]) throw new Error(`--${key} is required`);
  }
  const state = resolve(values["state-dir"]!);
  await mkdir(state, { mode: 0o700 });
  await copyFile(resolve(values["providers-file"]!), join(state, "providers.json"));
  await copyFile(resolve(values["config-file"]!), join(state, "config.json"));
  const selection = await new ConfigService({ cwd: state, globalDirectory: state }).resolveModel(
    values.agent!,
  );
  if (!selection) throw new Error("No valid model selection for execution");
  const service = await createModelService({ cwd: state, globalDirectory: state });
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
