import { createToolRoutineApprovalScope, isAgentId } from "@omni-agent/core";
import {
  isPersistedToolIdentity,
  isRecord,
  type PersistedAgentPermissions,
  type PersistedPermissionGrant,
  type PersistedPermissions,
} from "../persisted-types";

export interface PermissionMigrationResult {
  value: PersistedPermissions;
  droppedIdentities: string[];
}

export function migratePermissionsToV3(value: unknown): PermissionMigrationResult | null {
  if (!isRecord(value) || (value.version !== 1 && value.version !== 2) || !isRecord(value.agents)) {
    return null;
  }
  const agents: Record<string, PersistedAgentPermissions> = {};
  const droppedIdentities: string[] = [];
  for (const [agentId, raw] of Object.entries(value.agents)) {
    if (!isAgentId(agentId) || !isRecord(raw)) continue;
    const mode = raw.mode === "standard" ? "standard" : "supervised";
    const persistentApprovals: PersistedPermissionGrant[] = [];
    const identities = new Set<string>();
    if (Array.isArray(raw.alwaysApproveTools)) {
      for (const entry of raw.alwaysApproveTools) {
        if (
          !isRecord(entry) ||
          typeof entry.toolIdentity !== "string" ||
          typeof entry.toolName !== "string"
        ) {
          continue;
        }
        const identity =
          value.version === 1 && entry.toolIdentity.startsWith("coding:")
            ? `builtin-coding:${entry.toolIdentity.slice("coding:".length)}`
            : entry.toolIdentity;
        if (!isPersistedToolIdentity(identity, entry.toolName) || identities.has(identity)) {
          droppedIdentities.push(entry.toolIdentity);
          continue;
        }
        identities.add(identity);
        const scope = createToolRoutineApprovalScope(entry.toolName);
        persistentApprovals.push({
          toolIdentity: identity,
          toolName: entry.toolName,
          scopeKey: scope.key,
          scopeKind: scope.kind,
          label: scope.label,
        });
      }
    }
    agents[agentId] = { mode, persistentApprovals };
  }
  return { value: { version: 3, agents }, droppedIdentities };
}
