import {
  captureModelConfiguration,
  ConfigService,
  createModelService,
  resolveAgentModel,
} from "@omni-agent/app";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

async function main() {
  const { values } = parseArgs({
    options: {
      cwd: { type: "string", default: process.cwd() },
      "global-directory": { type: "string", default: join(homedir(), ".omni-agent") },
      "config-file": { type: "string" },
      "providers-file": { type: "string" },
      "output-dir": { type: "string" },
      "credential-env": { type: "string" },
      agent: { type: "string", default: "coding" },
    },
  });
  if (!values["output-dir"] || !values["credential-env"])
    throw new Error("--output-dir and --credential-env are required");
  const output = resolve(values["output-dir"]);
  const captured = await captureModelConfiguration({
    cwd: resolve(values.cwd),
    globalDirectory: resolve(values["global-directory"]),
    configFile: values["config-file"],
    providersFile: values["providers-file"],
    credentialEnvironment: values["credential-env"],
    outputDirectory: output,
  });
  // This deployment explicitly supports environment authentication, never host Keychain/OAuth.
  const models = await createModelService({
    cwd: output,
    globalDirectory: output,
    authEnvironment: captured.authEnvironment,
    credentials: {
      read: async () => undefined,
      list: async () => [],
      modify: async () => {
        throw new Error("Credential writes are unavailable in configuration capture");
      },
      delete: async () => {
        throw new Error("Credential writes are unavailable in configuration capture");
      },
    },
  });
  try {
    await resolveAgentModel(
      values.agent,
      new ConfigService({ cwd: output, globalDirectory: output }),
      models,
    );
    process.stdout.write(JSON.stringify(captured) + "\n");
  } finally {
    await models.dispose();
  }
}
