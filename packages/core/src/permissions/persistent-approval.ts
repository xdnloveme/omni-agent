import { sanitizePermissionLabel } from "./presentation";
import type {
  PersistentApprovalReference,
  PersistentApprovalScope,
  PersistentApprovalScopeKind,
} from "./types";

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
  const label = scope.label;
  return (
    isPersistentApprovalReference(scope) && typeof label === "string" && SAFE_LABEL.test(label)
  );
}

export function isPersistentApprovalReference(
  value: unknown,
): value is PersistentApprovalReference {
  if (!value || typeof value !== "object") return false;
  const reference = value as { key?: unknown; kind?: unknown };
  return (
    isPersistentApprovalScopeKey(reference.key) && isPersistentApprovalScopeKind(reference.kind)
  );
}

export function isPersistentApprovalScopeKey(value: unknown): value is string {
  return typeof value === "string" && SCOPE_KEY.test(value);
}

function isPersistentApprovalScopeKind(value: unknown): value is PersistentApprovalScopeKind {
  return (
    value === "tool_routine" ||
    value === "bash_executable" ||
    value === "filesystem_read_directory" ||
    value === "filesystem_read_file" ||
    value === "filesystem_write_directory"
  );
}

export function isAgentScopedApprovalKind(kind: PersistentApprovalScopeKind): boolean {
  return (
    kind === "filesystem_read_directory" ||
    kind === "filesystem_read_file" ||
    kind === "filesystem_write_directory"
  );
}
