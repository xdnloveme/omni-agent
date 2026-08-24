import type { PersistedAgentExecutionSettings } from "../persisted-types";
import { isRecord } from "../persisted-types";

export interface LegacyPermissionMigration {
  readonly settings: PersistedAgentExecutionSettings;
  readonly discardedApprovals: number;
}

export function migratePermissionsV3Agent(
  value: unknown,
  agentId: string,
): LegacyPermissionMigration | undefined {
  if (!isRecord(value) || value.version !== 3 || !isRecord(value.agents)) return undefined;
  const agent = value.agents[agentId];
  if (!isRecord(agent)) return undefined;
  return {
    settings: {
      mode: "controlled",
      controlledNetworkEnabled: false,
      approvedFilesystemRoots: [],
    },
    discardedApprovals: Array.isArray(agent.persistentApprovals)
      ? agent.persistentApprovals.length
      : 0,
  };
}
