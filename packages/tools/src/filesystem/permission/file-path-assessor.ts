import type { PermissionAssessment } from "@omni-agent/core";
import { inspectPathSecurity } from "../../security/path/inspect-path-security";

export type FileAccess = "read" | "write";

export async function assessFilePath(
  value: string,
  cwd: string,
  access: FileAccess,
): Promise<PermissionAssessment> {
  const { target, sensitive, inWorkspace } = await inspectPathSecurity(value, cwd);

  const risk = sensitive
    ? access === "write"
      ? "privileged"
      : "external"
    : inWorkspace
      ? access
      : "external";
  const reason = sensitive
    ? `${access === "write" ? "Writing" : "Reading"} a sensitive ${sensitive} path`
    : inWorkspace
      ? `${access === "write" ? "Writes to" : "Reads from"} the workspace`
      : `${access === "write" ? "Writes to" : "Reads from"} a path outside the workspace`;

  return {
    risk,
    operationClass: inWorkspace && !sensitive ? "routine" : "sensitive",
    enforcement: "policy",
    reasons: [reason],
    presentation: {
      title: `${access === "write" ? "Modify" : "Read"} file`,
      detail: target,
      reason,
    },
    ruleIds:
      !inWorkspace || sensitive
        ? [sensitive ? `path.sensitive.${sensitive}.${access}` : `path.outside-workspace.${access}`]
        : [],
  };
}
