import type { PermissionAssessment } from "@omni-agent/core";
import { classifyBashCommand } from "./classify-command";
import { assessShellPaths } from "./shell-path-assessor";

export async function assessBashPermission(
  input: Record<string, unknown>,
  context: { cwd: string },
): Promise<PermissionAssessment> {
  const command = input.command;
  if (typeof command !== "string") throw new Error("command must be a string");
  const classification = classifyBashCommand(command, context.cwd);
  const paths = await assessShellPaths(command, context.cwd);
  const risk = paths.hasSensitivePath
    ? classification.risk === "read"
      ? "external"
      : "privileged"
    : paths.hasExternalPath && ["read", "write", "execute"].includes(classification.risk)
      ? "external"
      : classification.risk;
  const reasons = [...classification.reasons, ...paths.reasons];
  const transfersCredential =
    paths.hasSensitivePath && classification.effects.includes("network_transfer");
  return {
    risk,
    operationClass:
      paths.hasExternalPath || paths.hasSensitivePath ? "sensitive" : classification.operationClass,
    enforcement:
      classification.enforcement === "hard_deny" || transfersCredential ? "hard_deny" : "policy",
    reasons,
    ruleIds: [
      ...classification.ruleIds,
      ...paths.ruleIds,
      ...(transfersCredential ? ["shell.hard.credential-transfer"] : []),
    ],
    presentation: {
      title: "Run shell command",
      detail: command,
      reason: reasons[0] ?? "Shell command requires permission",
    },
  };
}
