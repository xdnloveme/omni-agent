import {
  inspectPathSecurity,
  type PathSecurityInspection,
  type PathTargetKind,
} from "./inspect-path-security";

export interface PathPreflightIssue {
  code: "invalid_path" | "path_not_found" | "dangling_symlink" | "unsupported_path";
  message: string;
  retryable: boolean;
}

export type PathPreflightResult =
  | { outcome: "ready"; inspection: PathSecurityInspection }
  | { outcome: "error"; issue: PathPreflightIssue };

export async function inspectPathPreflight(
  value: unknown,
  cwd: string,
  options: {
    acceptedKinds: readonly PathTargetKind[];
    operation: string;
  },
): Promise<PathPreflightResult> {
  if (typeof value !== "string") {
    return issue("invalid_path", "Path must be a string", false);
  }
  const inspection = await inspectPathSecurity(value, cwd);
  // Device access is a permission hard-stop, so the assessor owns its canonical denial.
  if (inspection.sensitivity === "device") return { outcome: "ready", inspection };
  if (inspection.targetKind === "dangling_symlink") {
    return issue("dangling_symlink", `Cannot ${options.operation} a dangling symbolic link`, false);
  }
  if (!options.acceptedKinds.includes(inspection.targetKind)) {
    return inspection.targetKind === "missing"
      ? issue("path_not_found", `Cannot ${options.operation} a missing path`, true)
      : issue(
          "unsupported_path",
          `Cannot ${options.operation} this type of filesystem target`,
          false,
        );
  }
  return { outcome: "ready", inspection };
}

function issue(
  code: PathPreflightIssue["code"],
  message: string,
  retryable: boolean,
): PathPreflightResult {
  return {
    outcome: "error",
    issue: { code, message, retryable },
  };
}
