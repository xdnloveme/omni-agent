import crypto from "node:crypto";
import path from "node:path";
import type {
  PersistentApprovalRequirement,
  PersistentApprovalScope,
  PersistentApprovalScopeKind,
} from "@omni-agent/core";

export function createPathReadDirectoryRequirement(
  directory: string,
): PersistentApprovalRequirement {
  const approval = scope(
    "filesystem:read:directory",
    "filesystem_read_directory",
    directory,
    `Always allow reads under ${directory}`,
  );
  return {
    approval,
    satisfiedBy: ancestorScopes(directory, "filesystem:read:directory").map((key) => ({
      key,
      kind: approval.kind,
    })),
  };
}

export function createPathReadFileRequirement(file: string): PersistentApprovalRequirement {
  const approval = scope(
    "filesystem:read:file",
    "filesystem_read_file",
    file,
    `Always allow reading ${file}`,
  );
  return { approval, satisfiedBy: [{ key: approval.key, kind: approval.kind }] };
}

export function createPathWriteDirectoryRequirement(
  directory: string,
): PersistentApprovalRequirement {
  const approval = scope(
    "filesystem:write:directory",
    "filesystem_write_directory",
    directory,
    `Always allow writes under ${directory}`,
  );
  return {
    approval,
    satisfiedBy: ancestorScopes(directory, "filesystem:write:directory").map((key) => ({
      key,
      kind: approval.kind,
    })),
  };
}

export function parentDirectory(target: string): string {
  return path.dirname(target);
}

function ancestorScopes(directory: string, prefix: string): string[] {
  const keys: string[] = [];
  let cursor = directory;
  while (true) {
    keys.push(scopeKey(prefix, cursor));
    const parent = path.dirname(cursor);
    if (parent === cursor) return keys;
    cursor = parent;
  }
}

function scope(
  prefix: string,
  kind: PersistentApprovalScopeKind,
  target: string,
  label: string,
): PersistentApprovalScope {
  return { key: scopeKey(prefix, target), kind, label };
}

function scopeKey(prefix: string, target: string): string {
  return `${prefix}:${crypto.createHash("sha256").update(target).digest("hex")}`;
}
