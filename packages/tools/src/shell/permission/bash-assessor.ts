import os from "node:os";
import type { PermissionAssessment } from "@omni-agent/core";
import { analyzeShellCommand } from "./analysis";

export async function assessBashPermission(
  input: Record<string, unknown>,
  context: { cwd: string; signal?: AbortSignal },
): Promise<PermissionAssessment> {
  const command = input.command;
  if (typeof command !== "string") throw new Error("command must be a string");
  const analysis = await analyzeShellCommand({
    command,
    cwd: context.cwd,
    signal: context.signal,
    environment: { platform: process.platform, home: os.homedir() },
  });
  const { security } = analysis;
  return {
    ...security,
    ...(analysis.approvalRequirements.length
      ? { persistentApprovalRequirements: analysis.approvalRequirements }
      : {}),
    presentation: {
      title: "Run shell command",
      detail: command,
      reason: security.reasons[0] ?? "Shell command requires permission",
    },
  };
}
