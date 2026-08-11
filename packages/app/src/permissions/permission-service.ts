import { isAgentId, type PermissionGrantStore, type PermissionMode } from "@omni-agent/core";
import { PermissionRepository } from "./permission-repository";
import type { PersistedAgentPermissions, PersistedToolApproval } from "./persisted-types";
import { isPersistedToolIdentity } from "./persisted-types";

const DEFAULT_AGENT_PERMISSIONS: PersistedAgentPermissions = {
  mode: "standard",
  alwaysApproveTools: [],
};

export interface PermissionDiagnostic {
  code: "invalid_permissions" | "migration_dropped_approval" | "read_failed";
  message: string;
}

export class PermissionService implements PermissionGrantStore {
  readonly diagnostics: PermissionDiagnostic[] = [];

  constructor(private readonly repository: PermissionRepository) {}

  async getMode(agentId: string): Promise<PermissionMode> {
    return (await this.readAgent(agentId)).mode;
  }

  async setMode(agentId: string, mode: PermissionMode): Promise<void> {
    assertAgentId(agentId);
    await this.updateAgent(agentId, (current) => ({ ...current, mode }));
  }

  async isToolAlwaysApproved(agentId: string, toolIdentity: string): Promise<boolean> {
    return (await this.readAgent(agentId)).alwaysApproveTools.some(
      (tool) => tool.toolIdentity === toolIdentity,
    );
  }

  async approveTool(agentId: string, toolIdentity: string, toolName: string): Promise<void> {
    assertAgentId(agentId);
    if (!isPersistedToolIdentity(toolIdentity, toolName)) {
      throw new Error(`Invalid tool identity: ${toolIdentity}`);
    }
    await this.updateAgent(agentId, (current) => {
      if (current.alwaysApproveTools.some((tool) => tool.toolIdentity === toolIdentity))
        return current;
      return {
        ...current,
        alwaysApproveTools: [...current.alwaysApproveTools, { toolIdentity, toolName }],
      };
    });
  }

  async listAlwaysApprovedTools(agentId: string): Promise<PersistedToolApproval[]> {
    return [...(await this.readAgent(agentId)).alwaysApproveTools];
  }

  async revokeAlwaysApprovedTool(agentId: string, toolIdentity: string): Promise<void> {
    await this.updateAgent(agentId, (current) => ({
      ...current,
      alwaysApproveTools: current.alwaysApproveTools.filter(
        (tool) => tool.toolIdentity !== toolIdentity,
      ),
    }));
  }

  async clearAlwaysApprovedTools(agentId: string): Promise<void> {
    await this.updateAgent(agentId, (current) => ({ ...current, alwaysApproveTools: [] }));
  }

  private async readAgent(agentId: string): Promise<PersistedAgentPermissions> {
    assertAgentId(agentId);
    try {
      const config = await this.repository.read();
      this.diagnostics.splice(
        0,
        this.diagnostics.length,
        ...this.repository.diagnostics.map((message) => ({
          code: "migration_dropped_approval" as const,
          message,
        })),
      );
      return config?.agents[agentId] ?? structuredClone(DEFAULT_AGENT_PERMISSIONS);
    } catch (error) {
      this.diagnostics.splice(0, this.diagnostics.length, {
        code:
          error instanceof SyntaxError ||
          (error instanceof Error && error.message.includes("format is invalid"))
            ? "invalid_permissions"
            : "read_failed",
        message: error instanceof Error ? error.message : String(error),
      });
      return { mode: "supervised", alwaysApproveTools: [] };
    }
  }

  private updateAgent(
    agentId: string,
    mutator: (current: PersistedAgentPermissions) => PersistedAgentPermissions,
  ): Promise<void> {
    return this.repository.update((config) => ({
      ...config,
      agents: {
        ...config.agents,
        [agentId]: mutator(config.agents[agentId] ?? structuredClone(DEFAULT_AGENT_PERMISSIONS)),
      },
    }));
  }
}

function assertAgentId(agentId: string): void {
  if (!isAgentId(agentId)) throw new Error(`Invalid Agent ID: ${agentId}`);
}
