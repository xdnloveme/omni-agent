import type { PermissionAssessment } from "@omni-agent/core";
import { inspectPathSecurity } from "../../security/path/inspect-path-security";

export async function assessSearchPath(value: string, cwd: string): Promise<PermissionAssessment> {
  const { target, sensitive, inWorkspace } = await inspectPathSecurity(value, cwd);
  const risk = sensitive || !inWorkspace ? "external" : "read";
  const reason = sensitive
    ? `Searches a sensitive ${sensitive} path`
    : inWorkspace
      ? "Searches within the workspace"
      : "Searches a path outside the workspace";
  return {
    risk,
    operationClass: inWorkspace && !sensitive ? "routine" : "sensitive",
    enforcement: "policy",
    reasons: [reason],
    ruleIds: sensitive
      ? [`search.path.sensitive.${sensitive}`]
      : inWorkspace
        ? []
        : ["search.path.outside-workspace"],
    presentation: { title: "Search files", detail: target, reason },
  };
}
