import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { throwIfAborted } from "@omni-agent/core";
import { analyzeShellCommand } from "../../shell/security/analysis";
import { SHELL_INTERPRETERS } from "../../shell/security/semantics/shell-builtins";
import { SandboxProcessError } from "../sandbox-process-error";
import type { HostRuntimeSnapshot } from "./types";

const MAX_SHELL_SCRIPT_BYTES = 256 * 1024;
export async function discoverShellScriptRequirements(
  scriptPath: string,
  interpreter: string,
  snapshot: HostRuntimeSnapshot,
  signal?: AbortSignal,
): Promise<readonly ShellScriptExecutableRequirement[]> {
  if (!SHELL_INTERPRETERS.has(path.basename(interpreter))) return [];
  throwIfAborted(signal);
  const metadata = await stat(scriptPath);
  if (metadata.size > MAX_SHELL_SCRIPT_BYTES) {
    throw new SandboxProcessError(
      "sandbox_runtime_projection_limit",
      "Shell executable exceeds the bounded dependency-analysis size.",
    );
  }
  const source = await readFile(scriptPath, "utf8");
  throwIfAborted(signal);
  const analysis = await analyzeShellCommand({
    command: source,
    cwd: path.dirname(scriptPath),
    // Cached dependency discovery uses a file-local analysis root, not call authorization.
    workspaceRoot: path.dirname(scriptPath),
    signal,
    environment: {
      platform: snapshot.platform,
      home: snapshot.home,
    },
  });
  return [
    ...new Map(
      analysis.commands
        .filter(
          ({ executionKind, executableToken }) =>
            executionKind === "external" && Boolean(executableToken),
        )
        .filter(({ effectiveCwd }) => effectiveCwd !== "unknown")
        .map(({ executableToken, effectiveCwd }) => [
          `${executableToken}\0${effectiveCwd}`,
          { command: executableToken, cwd: effectiveCwd as string },
        ]),
    ).values(),
  ];
}

export interface ShellScriptExecutableRequirement {
  readonly command: string;
  readonly cwd: string;
}
