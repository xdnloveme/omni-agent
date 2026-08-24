import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProcessExecutionPlan, ProcessResult } from "@omni-agent/core";
import type { SandboxPathScope } from "@omni-agent/core";
import { createSensitiveReadPolicySnapshot } from "../security/path/sensitive-policy-snapshot";
import type { HostRuntimeSnapshot } from "./executable/types";
import { runHostProcess } from "./host-process-runner";
import type { SandboxBinaryResolver } from "./sandbox-binary-resolver";
import { sandboxLaunchFailure } from "./sandbox-protocol";
import { compileSandboxInvocation } from "./sandbox-policy-compiler";
import { withPrivateSandboxDirectory } from "./private-sandbox-directory";

export async function runSandboxProcess(
  plan: Extract<ProcessExecutionPlan, { route: "sandbox" }>,
  runtime: SandboxProcessRuntime,
  signal?: AbortSignal,
): Promise<ProcessResult> {
  const { binaryResolver, snapshot, systemRead } = runtime;
  const invocation = plan.invocation;
  const binary = await binaryResolver.resolve(signal);
  return withPrivateSandboxDirectory(async (privateTemp) => {
    const environment = await createSandboxEnvironment(
      invocation.env,
      privateTemp,
      snapshot.path,
      snapshot.home,
      snapshot.developerDirectory,
    );
    const approvedSensitiveReads = plan.policy.read
      .filter(({ scope }) => scope === "exact")
      .map(({ path: target }) => target);
    const sensitive = createSensitiveReadPolicySnapshot(approvedSensitiveReads, snapshot);
    const compiled = compileSandboxInvocation({
      invocation,
      policy: plan.policy,
      privateTemp,
      runtimeRead: plan.runtimeRead,
      systemRead,
      sensitive,
    });
    const result = await runHostProcess({
      command: binary,
      args: compiled.arguments,
      cwd: invocation.cwd,
      env: environment,
      signal,
      maxOutputBytes: invocation.maxOutputBytes,
    });
    const failure = sandboxLaunchFailure(result.exitCode, result.stderr, compiled.diagnosticToken);
    if (failure) throw failure;
    return result;
  });
}

export interface SandboxProcessRuntime {
  readonly snapshot: HostRuntimeSnapshot;
  readonly binaryResolver: SandboxBinaryResolver;
  readonly systemRead: readonly SandboxPathScope[];
}

async function createSandboxEnvironment(
  invocationEnvironment: NodeJS.ProcessEnv | undefined,
  privateTemp: string,
  trustedPath: string,
  trustedHome: string,
  trustedDeveloperDirectory: string | undefined,
): Promise<NodeJS.ProcessEnv> {
  const config = path.join(privateTemp, "config");
  const cache = path.join(privateTemp, "cache");
  const state = path.join(privateTemp, "state");
  const npmrc = path.join(privateTemp, "npm-config");
  await Promise.all([
    mkdir(config),
    mkdir(cache),
    mkdir(state),
    writeFile(npmrc, "", { mode: 0o600 }),
  ]);
  const environment: NodeJS.ProcessEnv = {
    ...(invocationEnvironment ?? process.env),
    PATH: trustedPath,
    HOME: trustedHome,
    XDG_CONFIG_HOME: config,
    XDG_CACHE_HOME: cache,
    XDG_STATE_HOME: state,
    NPM_CONFIG_USERCONFIG: npmrc,
    npm_config_store_dir: path.join(privateTemp, "pnpm-store"),
  };
  if (trustedDeveloperDirectory) environment.DEVELOPER_DIR = trustedDeveloperDirectory;
  else delete environment.DEVELOPER_DIR;
  return environment;
}
