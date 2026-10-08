import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createNodeAuthContext, ProviderRepository } from "@omni-agent/models";
import { ConfigService } from "../config/config-service";
import { resolveWorkspaceContext } from "../workspaces";

/** Capture deployment inputs without duplicating model selection or Provider merge rules. */
export async function captureModelConfiguration(options: {
  cwd: string;
  globalDirectory: string;
  configFile?: string;
  providersFile?: string;
  credentialEnvironment: string;
  outputDirectory: string;
}): Promise<{ authEnvironment: Record<string, string> }> {
  const workspace = await resolveWorkspaceContext(options.cwd);
  const source = { cwd: workspace.root, globalDirectory: options.globalDirectory };
  const config = await new ConfigService({ ...source, projectFile: options.configFile }).snapshot();
  const providers = await new ProviderRepository({
    ...source,
    projectFile: options.providersFile,
  }).list();
  const auth = createNodeAuthContext(source.cwd, source.globalDirectory);
  const value = await auth.env(options.credentialEnvironment);
  const authEnvironment = value ? { [options.credentialEnvironment]: value } : {};
  await mkdir(options.outputDirectory, { mode: 0o700 });
  const hashes: Record<string, string> = {};
  const files: Record<string, string> = {
    "providers.json": JSON.stringify({ version: 1, vendors: providers }, null, 2) + "\n",
  };
  if (config.global !== undefined) files["config.json"] = config.global;
  if (config.project !== undefined) files["omni.config.json"] = config.project;
  for (const [name, text] of Object.entries(files)) {
    await writeFile(join(options.outputDirectory, name), text, { mode: 0o600, flag: "wx" });
    hashes[name] = createHash("sha256").update(text).digest("hex");
  }
  await writeFile(
    join(options.outputDirectory, "snapshot.json"),
    JSON.stringify({
      version: 1,
      source: {
        ...source,
        configFile: options.configFile ?? null,
        providersFile: options.providersFile ?? null,
      },
      files: hashes,
    }) + "\n",
    { mode: 0o600, flag: "wx" },
  );
  return { authEnvironment };
}
