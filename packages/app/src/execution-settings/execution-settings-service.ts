import {
  MAX_APPROVED_FILESYSTEM_ROOTS,
  MAX_APPROVED_NETWORK_TARGETS,
  normalizeFilesystemCapabilities,
  normalizeNetworkTargets,
  type ExecutionMode,
  type ExecutionSettingsPort,
  type FilesystemCapabilityScope,
  type WorkspaceExecutionSettings,
  type NetworkTarget,
} from "@omni-agent/core";
import { migratePermissionsV3Agent } from "./migrations/migrate-permissions-v3-to-execution-v4";
import { ExecutionSettingsRepository } from "./execution-settings-repository";

const DEFAULT_SETTINGS: WorkspaceExecutionSettings = {
  mode: "controlled",
  approvedFilesystemRoots: [],
  approvedNetworkTargets: [],
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

  addApprovedNetworkTargets(
    workspaceId: string,
    agentId: string,
    targets: readonly NetworkTarget[],
  ): Promise<void> {
    return this.addApprovedAccess(workspaceId, agentId, { targets, scopes: [] });
  }

  addApprovedAccess(
    workspaceId: string,
    agentId: string,
    access: {
      readonly scopes: readonly FilesystemCapabilityScope[];
      readonly targets: readonly NetworkTarget[];
    },
  ): Promise<void> {
    return this.updateAgent(workspaceId, agentId, (current) => {
      const approvedNetworkTargets = normalizeNetworkTargets([
        ...current.approvedNetworkTargets,
        ...access.targets,
      ]);
      const approvedFilesystemRoots = normalizeFilesystemCapabilities([
        ...current.approvedFilesystemRoots,
        ...access.scopes,
      ]);
      if (approvedNetworkTargets.length > MAX_APPROVED_NETWORK_TARGETS) {
        throw new Error(`Approved network targets cannot exceed ${MAX_APPROVED_NETWORK_TARGETS}`);
      }
      if (approvedFilesystemRoots.length > MAX_APPROVED_FILESYSTEM_ROOTS) {
        throw new Error(`Approved filesystem roots cannot exceed ${MAX_APPROVED_FILESYSTEM_ROOTS}`);
      }
      // One consent is one transaction: neither resource category can be partially saved.
      return { ...current, approvedNetworkTargets, approvedFilesystemRoots };
    });
  }

  revokeApprovedNetworkTarget(
    workspaceId: string,
    agentId: string,
    target: NetworkTarget,
  ): Promise<void> {
    const [normalized] = normalizeNetworkTargets([target]);
    return this.updateAgent(workspaceId, agentId, (current) => ({
      ...current,
      approvedNetworkTargets: current.approvedNetworkTargets.filter(
        (candidate) =>
          candidate.scheme !== normalized!.scheme ||
          candidate.host !== normalized!.host ||
          candidate.port !== normalized!.port,
      ),
    }));
  }

  clearApprovedNetworkTargets(workspaceId: string, agentId: string): Promise<void> {
    return this.updateAgent(workspaceId, agentId, (current) => ({
      ...current,
      approvedNetworkTargets: [],
    }));
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
        version: 6,
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
