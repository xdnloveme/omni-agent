import {
  isAgentId,
  isPersistentApprovalScope,
  type PermissionGrant,
  type PermissionMode,
} from "@omni-agent/core";

export type PersistedPermissionGrant = PermissionGrant;

export interface PersistedAgentPermissions {
  mode: PermissionMode;
  persistentApprovals: PersistedPermissionGrant[];
}

export interface PersistedPermissions {
  version: 3;
  agents: Record<string, PersistedAgentPermissions>;
}

export const EMPTY_PERMISSIONS: PersistedPermissions = { version: 3, agents: {} };

export function isPersistedPermissions(value: unknown): value is PersistedPermissions {
  if (!isRecord(value) || value.version !== 3 || !isRecord(value.agents)) return false;
  return Object.entries(value.agents).every(([agentId, permissions]) => {
    if (!isAgentId(agentId) || !isRecord(permissions)) return false;
    if (permissions.mode !== "standard" && permissions.mode !== "supervised") return false;
    if (!Array.isArray(permissions.persistentApprovals)) return false;
    const identities = new Set<string>();
    return permissions.persistentApprovals.every((grant) => {
      if (!isPersistedPermissionGrant(grant)) return false;
      const identity = `${grant.toolIdentity}\0${grant.scopeKey}`;
      if (identities.has(identity)) return false;
      identities.add(identity);
      return true;
    });
  });
}

export function isPersistedPermissionGrant(value: unknown): value is PersistedPermissionGrant {
  if (!isRecord(value)) return false;
  if (!hasExactKeys(value, ["toolIdentity", "toolName", "scopeKey", "scopeKind", "label"])) {
    return false;
  }
  if (
    typeof value.toolIdentity !== "string" ||
    typeof value.toolName !== "string" ||
    !isPersistedToolIdentity(value.toolIdentity, value.toolName)
  ) {
    return false;
  }
  if (
    !isPersistentApprovalScope({
      key: value.scopeKey,
      kind: value.scopeKind,
      label: value.label,
    })
  ) {
    return false;
  }
  return true;
}

export function isPersistedToolIdentity(identity: string, toolName: string): boolean {
  const match = identity.match(/^([a-z0-9]+(?:[._-][a-z0-9]+)*):([a-z][a-z0-9_-]*)$/);
  return match?.[1] !== "unscoped" && match?.[2] === toolName;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => key in value);
}
