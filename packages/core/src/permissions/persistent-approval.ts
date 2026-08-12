import { sanitizePermissionLabel } from "./presentation";
import type { PersistentApprovalScope } from "./types";

const SCOPE_KEY = /^[a-z][a-z0-9._:-]{0,255}$/;
const SAFE_LABEL = /^[^\u0000-\u001f\u007f]{1,160}$/;

export function createToolRoutineApprovalScope(toolName: string): PersistentApprovalScope {
  return {
    key: "tool:routine",
    kind: "tool_routine",
    label: sanitizePermissionLabel(`Always approve routine ${toolName} operations`),
  };
}

export function isPersistentApprovalScope(value: unknown): value is PersistentApprovalScope {
  if (!value || typeof value !== "object") return false;
  const scope = value as {
    key?: unknown;
    kind?: unknown;
    label?: unknown;
  };
  return (
    isPersistentApprovalScopeKey(scope.key) &&
    (scope.kind === "tool_routine" ||
      scope.kind === "bash_executable" ||
      scope.kind === "filesystem_read_directory" ||
      scope.kind === "filesystem_read_file" ||
      scope.kind === "filesystem_write_directory") &&
    typeof scope.label === "string" &&
    SAFE_LABEL.test(scope.label)
  );
}

export function isPersistentApprovalScopeKey(value: unknown): value is string {
  return typeof value === "string" && SCOPE_KEY.test(value);
}
