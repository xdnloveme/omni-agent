import type { PermissionAssessment } from "@omni-agent/core";
import {
  createPathReadDirectoryRequirement,
  createPathReadFileRequirement,
  parentDirectory,
} from "../../security/path/path-approval-scopes";
import { inspectPathSecurity } from "../../security/path/inspect-path-security";

export async function assessSearchPath(value: string, cwd: string): Promise<PermissionAssessment> {
  const inspection = await inspectPathSecurity(value, cwd);
  const { target, targetKind, sensitivity, inWorkspace } = inspection;
  const risk = sensitivity || !inWorkspace ? "external" : "read";
  const reason = sensitivity
    ? `Searches a sensitive ${sensitivity} path`
    : inWorkspace
      ? "Searches within the workspace"
      : "Searches a path outside the workspace";
  return {
    risk,
    operationClass: inWorkspace && !sensitivity ? "routine" : "sensitive",
    ...approvalRequirements(inspection),
    enforcement: sensitivity === "device" ? "hard_deny" : "policy",
    reasons: [reason],
    ruleIds: sensitivity
      ? [`search.path.sensitive.${sensitivity}`]
      : inWorkspace
        ? []
        : ["search.path.outside-workspace"],
    presentation: {
      title: targetKind === "regular_file" ? "Search file" : "Search files",
      detail: target,
      reason,
    },
  };
}

function approvalRequirements(
  inspection: Awaited<ReturnType<typeof inspectPathSecurity>>,
): Pick<PermissionAssessment, "persistentApprovalRequirements"> | Record<string, never> {
  const { target, targetKind, sensitivity, inWorkspace } = inspection;
  if (sensitivity === "device" || sensitivity === "virtual_system") return {};
  if (sensitivity) {
    if (targetKind !== "regular_file") return {};
    return {
      persistentApprovalRequirements: [createPathReadFileRequirement(target)],
    };
  }
  if (inWorkspace) return {};
  const directory = targetKind === "directory" ? target : parentDirectory(target);
  return {
    persistentApprovalRequirements: [createPathReadDirectoryRequirement(directory)],
  };
}
