import { SandboxProcessError } from "./sandbox-process-error";

export const SANDBOX_PROTOCOL_VERSION = "3";
export const SANDBOX_LAUNCH_FAILURE_EXIT_CODE = 125;

export function sandboxLaunchFailure(
  exitCode: number | null,
  stderr: string,
  diagnosticToken: string,
): SandboxProcessError | undefined {
  if (exitCode !== SANDBOX_LAUNCH_FAILURE_EXIT_CODE) return undefined;
  const match = new RegExp(
    `^omni-sandbox:${escapeRegExp(diagnosticToken)}:([a-z0-9_]+):\\s*(.+)$`,
    "m",
  ).exec(stderr);
  return match ? new SandboxProcessError(match[1]!, match[2]!) : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
