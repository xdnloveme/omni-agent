import {
  type PersistedExecutionSettings,
  type PersistedExecutionSettingsV5,
} from "../persisted-types";

export interface ExecutionSettingsV6Migration {
  readonly settings: PersistedExecutionSettings;
  readonly discardedCoarseNetworkGrants: number;
}

export function migrateExecutionSettingsV5(
  value: PersistedExecutionSettingsV5,
): ExecutionSettingsV6Migration {
  let discardedCoarseNetworkGrants = 0;
  const settings: PersistedExecutionSettings = {
    version: 6,
    workspaces: Object.fromEntries(
      Object.entries(value.workspaces).map(([workspaceId, workspace]) => [
        workspaceId,
        {
          agents: Object.fromEntries(
            Object.entries(workspace.agents).map(([agentId, agent]) => {
              if (agent.controlledNetworkEnabled) discardedCoarseNetworkGrants += 1;
              return [
                agentId,
                {
                  mode: agent.mode,
                  approvedFilesystemRoots: agent.approvedFilesystemRoots,
                  approvedNetworkTargets: [],
                },
              ];
            }),
          ),
        },
      ]),
    ),
  };
  return { settings, discardedCoarseNetworkGrants };
}
