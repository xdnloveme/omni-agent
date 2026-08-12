import type { PermissionAssessment } from "@omni-agent/core";
import { inspectPathSecurity } from "../../security/path/inspect-path-security";
import {
  createPathReadDirectoryRequirement,
  createPathReadFileRequirement,
  createPathWriteDirectoryRequirement,
  parentDirectory,
} from "../../security/path/path-approval-scopes";

export type FileAccess = "read" | "write";

export async function assessFilePath(
  value: string,
  cwd: string,
  access: FileAccess,
): Promise<PermissionAssessment> {
  const inspection = await inspectPathSecurity(value, cwd);
  const { target, sensitivity, inWorkspace } = inspection;

  const risk = sensitivity
    ? access === "write"
      ? "privileged"
      : "external"
    : inWorkspace
      ? access
      : "external";
  const reason = sensitivity
    ? `${access === "write" ? "Writing" : "Reading"} a sensitive ${sensitivity} path`
    : inWorkspace
      ? `${access === "write" ? "Writes to" : "Reads from"} the workspace`
      : `${access === "write" ? "Writes to" : "Reads from"} a path outside the workspace`;

  return {
    risk,
    operationClass: inWorkspace && !sensitivity ? "routine" : "sensitive",
    ...approvalRequirements(inspection, access),
    enforcement: sensitivity === "device" ? "hard_deny" : "policy",
    reasons: [reason],
    presentation: {
      title: `${access === "write" ? "Modify" : "Read"} file`,
      detail: target,
      reason,
    },
    ruleIds:
      !inWorkspace || sensitivity
        ? [
            sensitivity
              ? `path.sensitive.${sensitivity}.${access}`
              : `path.outside-workspace.${access}`,
          ]
        : [],
  };
}

function approvalRequirements(
  inspection: Awaited<ReturnType<typeof inspectPathSecurity>>,
  access: FileAccess,
): Pick<PermissionAssessment, "persistentApprovalRequirements"> | Record<string, never> {
  const { target, sensitivity, inWorkspace } = inspection;
  if (sensitivity === "device" || sensitivity === "virtual_system") return {};
  if (access === "write") {
    if (sensitivity) return {};
    if (inWorkspace) return {};
    return {
      persistentApprovalRequirements: [
        createPathWriteDirectoryRequirement(parentDirectory(target)),
      ],
    };
  }
  if (sensitivity) {
    return {
      persistentApprovalRequirements: [createPathReadFileRequirement(target)],
    };
  }
  if (!inWorkspace) {
    return {
      persistentApprovalRequirements: [createPathReadDirectoryRequirement(parentDirectory(target))],
    };
  }
  return {};
}
