import type {
  PersistedExecutionSettingsV4,
  PersistedExecutionSettingsV5,
} from "../persisted-types";

export function migrateExecutionSettingsV4(
  value: PersistedExecutionSettingsV4,
): PersistedExecutionSettingsV5 {
  return {
    version: 5,
    workspaces: Object.fromEntries(
      Object.entries(value.workspaces).map(([workspaceId, workspace]) => [
        workspaceId,
        {
          agents: Object.fromEntries(
            Object.entries(workspace.agents).map(([agentId, settings]) => [
              agentId,
              { ...settings, approvedFilesystemRoots: [] },
            ]),
          ),
        },
      ]),
    ),
  };
}
