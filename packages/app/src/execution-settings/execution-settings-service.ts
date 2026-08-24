import {
  MAX_APPROVED_FILESYSTEM_ROOTS,
  normalizeFilesystemCapabilities,
  type ExecutionMode,
  type ExecutionSettingsPort,
  type FilesystemCapabilityScope,
  type WorkspaceExecutionSettings,
} from "@omni-agent/core";
import { migratePermissionsV3Agent } from "./migrations/migrate-permissions-v3-to-execution-v4";
import { ExecutionSettingsRepository } from "./execution-settings-repository";

const DEFAULT_SETTINGS: WorkspaceExecutionSettings = {
  mode: "controlled",
  controlledNetworkEnabled: false,
  approvedFilesystemRoots: [],
};

export class ExecutionSettingsService implements ExecutionSettingsPort {
  constructor(private readonly repository: ExecutionSettingsRepository) {}

  async getSettings(workspaceId: string, agentId: string): Promise<WorkspaceExecutionSettings> {
    const persisted = await this.repository.read();
    const current = persisted?.workspaces[workspaceId]?.agents[agentId];
    if (current) return current;
    if (!persisted) await this.migrateLegacy(workspaceId, agentId);
    const migrated = (await this.repository.read())?.workspaces[workspaceId]?.agents[agentId];
    return migrated ?? DEFAULT_SETTINGS;
  }

  setMode(workspaceId: string, agentId: string, mode: ExecutionMode): Promise<void> {
    return this.updateAgent(workspaceId, agentId, (current) => ({ ...current, mode }));
  }

  enableControlledNetwork(workspaceId: string, agentId: string): Promise<void> {
    return this.setControlledNetworkEnabled(workspaceId, agentId, true);
  }

  setControlledNetworkEnabled(
    workspaceId: string,
    agentId: string,
    enabled: boolean,
  ): Promise<void> {
    return this.updateAgent(workspaceId, agentId, (current) => ({
      ...current,
      controlledNetworkEnabled: enabled,
    }));
  }

  addApprovedFilesystemRoots(
    workspaceId: string,
    agentId: string,
    roots: readonly FilesystemCapabilityScope[],
  ): Promise<void> {
    return this.updateAgent(workspaceId, agentId, (current) => {
      const approvedFilesystemRoots = normalizeFilesystemCapabilities([
        ...current.approvedFilesystemRoots,
        ...roots,
      ]);
      if (approvedFilesystemRoots.length > MAX_APPROVED_FILESYSTEM_ROOTS) {
        throw new Error(`Approved filesystem roots cannot exceed ${MAX_APPROVED_FILESYSTEM_ROOTS}`);
      }
      return { ...current, approvedFilesystemRoots };
    });
  }

  revokeApprovedFilesystemRoot(
    workspaceId: string,
    agentId: string,
    root: FilesystemCapabilityScope,
  ): Promise<void> {
    return this.updateAgent(workspaceId, agentId, (current) => ({
      ...current,
      approvedFilesystemRoots: current.approvedFilesystemRoots.filter(
        (candidate) =>
          candidate.path !== root.path ||
          candidate.scope !== root.scope ||
          candidate.access !== root.access,
      ),
    }));
  }

  clearApprovedFilesystemRoots(workspaceId: string, agentId: string): Promise<void> {
    return this.updateAgent(workspaceId, agentId, (current) => ({
      ...current,
      approvedFilesystemRoots: [],
    }));
  }

  private async migrateLegacy(workspaceId: string, agentId: string): Promise<void> {
    const migration = migratePermissionsV3Agent(
      await this.repository.readLegacyPermissions(),
      agentId,
    );
    if (migration?.discardedApprovals) {
      this.repository.diagnostics.push(
        `Discarded ${migration.discardedApprovals} legacy persistent approval(s) for ${agentId}.`,
      );
    }
    await this.updateAgent(workspaceId, agentId, () => migration?.settings ?? DEFAULT_SETTINGS);
  }

  private updateAgent(
    workspaceId: string,
    agentId: string,
    update: (current: WorkspaceExecutionSettings) => WorkspaceExecutionSettings,
  ): Promise<void> {
    return this.repository.update((current) => {
      const workspace = current.workspaces[workspaceId] ?? { agents: {} };
      const next = update(workspace.agents[agentId] ?? DEFAULT_SETTINGS);
      return {
        version: 5,
        workspaces: {
          ...current.workspaces,
          [workspaceId]: {
            agents: { ...workspace.agents, [agentId]: next },
          },
        },
      };
    });
  }
}
