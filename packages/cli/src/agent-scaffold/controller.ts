import { resolve } from "node:path";
import type { CliHostServices } from "../host-services";
import { CLI_VERSION } from "../version";
import { createAgentScaffold } from "./scaffolder";

export async function runAgentScaffold(
  agentId: string,
  directory: string,
  host: CliHostServices,
): Promise<{ readonly exitCode: 0 }> {
  const created = await createAgentScaffold({
    agentId,
    directory: resolve(host.runtime.cwd, directory),
    frameworkVersion: CLI_VERSION,
  });
  host.output.stdout(`Created Agent package ${created.agentId} at ${created.directory}\n`);
  return { exitCode: 0 };
}
