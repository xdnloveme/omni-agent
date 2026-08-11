import { isAgentId, type PermissionMode } from "@omni-agent/core";

export interface PersistedToolApproval {
  toolIdentity: string;
  toolName: string;
}

export interface PersistedAgentPermissions {
  mode: PermissionMode;
  alwaysApproveTools: PersistedToolApproval[];
}

export interface PersistedPermissions {
  version: 2;
  agents: Record<string, PersistedAgentPermissions>;
}

export const EMPTY_PERMISSIONS: PersistedPermissions = { version: 2, agents: {} };

export function isPersistedPermissions(value: unknown): value is PersistedPermissions {
  if (!isRecord(value) || value.version !== 2 || !isRecord(value.agents)) return false;
  return Object.entries(value.agents).every(([agentId, permissions]) => {
    if (!isAgentId(agentId) || !isRecord(permissions)) return false;
    if (permissions.mode !== "standard" && permissions.mode !== "supervised") return false;
    if (!Array.isArray(permissions.alwaysApproveTools)) return false;
    return permissions.alwaysApproveTools.every(
      (tool) =>
        isRecord(tool) &&
        typeof tool.toolIdentity === "string" &&
        typeof tool.toolName === "string" &&
        isPersistedToolIdentity(tool.toolIdentity, tool.toolName),
    );
  });
}

export function isPersistedToolIdentity(identity: string, toolName: string): boolean {
  const match = identity.match(/^([a-z0-9]+(?:[._-][a-z0-9]+)*):([a-z][a-z0-9_-]*)$/);
  return match?.[1] !== "unscoped" && match?.[2] === toolName;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
