import { isAgentId } from "@omni-agent/core";
import {
  isPersistedToolIdentity,
  isRecord,
  type PersistedAgentPermissions,
  type PersistedPermissions,
} from "../persisted-types";

export interface PermissionMigrationResult {
  value: PersistedPermissions;
  droppedIdentities: string[];
}

export function migratePermissionsV1ToV2(value: unknown): PermissionMigrationResult | null {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.agents)) return null;
  const agents: Record<string, PersistedAgentPermissions> = {};
  const droppedIdentities: string[] = [];
  for (const [agentId, raw] of Object.entries(value.agents)) {
    if (!isAgentId(agentId) || !isRecord(raw)) continue;
    const mode = raw.mode === "standard" ? "standard" : "supervised";
    const approvals: PersistedAgentPermissions["alwaysApproveTools"] = [];
    const identities = new Set<string>();
    if (Array.isArray(raw.alwaysApproveTools)) {
      for (const entry of raw.alwaysApproveTools) {
        if (
          !isRecord(entry) ||
          typeof entry.toolIdentity !== "string" ||
          typeof entry.toolName !== "string"
        )
          continue;
        const identity = entry.toolIdentity.startsWith("coding:")
          ? `builtin-coding:${entry.toolIdentity.slice("coding:".length)}`
          : entry.toolIdentity;
        if (!isPersistedToolIdentity(identity, entry.toolName) || identities.has(identity)) {
          droppedIdentities.push(entry.toolIdentity);
          continue;
        }
        identities.add(identity);
        approvals.push({ toolIdentity: identity, toolName: entry.toolName });
      }
    }
    agents[agentId] = { mode, alwaysApproveTools: approvals };
  }
  return { value: { version: 2, agents }, droppedIdentities };
}
