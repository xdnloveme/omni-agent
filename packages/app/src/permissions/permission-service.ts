import { createHash } from "node:crypto";
import {
  isAgentId,
  type PermissionGrant,
  type PermissionGrantStore,
  type PermissionMode,
} from "@omni-agent/core";
import { PermissionRepository } from "./permission-repository";
import type { PersistedAgentPermissions } from "./persisted-types";
import { isPersistedPermissionGrant } from "./persisted-types";

const DEFAULT_AGENT_PERMISSIONS: PersistedAgentPermissions = {
  mode: "standard",
  persistentApprovals: [],
};

export interface PersistentApprovalView extends PermissionGrant {
  id: string;
}

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

  async getGrantedScopeKeys(
    agentId: string,
    toolIdentity: string,
    scopeKeys: readonly string[],
  ): Promise<readonly string[]> {
    const requested = new Set(scopeKeys);
    return (await this.readAgent(agentId)).persistentApprovals
      .filter((grant) => grant.toolIdentity === toolIdentity && requested.has(grant.scopeKey))
      .map((grant) => grant.scopeKey);
  }

  async saveGrants(agentId: string, grants: readonly PermissionGrant[]): Promise<void> {
    assertAgentId(agentId);
    if (!grants.length || grants.some((grant) => !isPersistedPermissionGrant(grant))) {
      throw new Error("Invalid persistent approval grants");
    }
    const uniqueGrants = [
      ...new Map(
        grants.map((grant) => [`${grant.toolIdentity}\0${grant.scopeKey}`, grant] as const),
      ).values(),
    ];
    await this.updateAgent(agentId, (current) => {
      const existing = new Set(
        current.persistentApprovals.map((entry) => `${entry.toolIdentity}\0${entry.scopeKey}`),
      );
      const additions = uniqueGrants.filter(
        (grant) => !existing.has(`${grant.toolIdentity}\0${grant.scopeKey}`),
      );
      if (!additions.length) return current;
      return {
        ...current,
        persistentApprovals: [...current.persistentApprovals, ...structuredClone(additions)],
      };
    });
  }

  async listPersistentApprovals(agentId: string): Promise<PersistentApprovalView[]> {
    return (await this.readAgent(agentId)).persistentApprovals.map((grant) => ({
      ...grant,
      id: grantId(grant),
    }));
  }

  async revokePersistentApproval(agentId: string, id: string): Promise<void> {
    await this.updateAgent(agentId, (current) => ({
      ...current,
      persistentApprovals: current.persistentApprovals.filter((grant) => grantId(grant) !== id),
    }));
  }

  async clearPersistentApprovals(agentId: string): Promise<void> {
    await this.updateAgent(agentId, (current) => ({ ...current, persistentApprovals: [] }));
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
      return { mode: "supervised", persistentApprovals: [] };
    }
  }

  private updateAgent(
    agentId: string,
    mutator: (current: PersistedAgentPermissions) => PersistedAgentPermissions,
  ): Promise<void> {
    assertAgentId(agentId);
    return this.repository.update((config) => ({
      ...config,
      agents: {
        ...config.agents,
        [agentId]: mutator(config.agents[agentId] ?? structuredClone(DEFAULT_AGENT_PERMISSIONS)),
      },
    }));
  }
}

function grantId(grant: PermissionGrant): string {
  return createHash("sha256")
    .update(`${grant.toolIdentity}\0${grant.scopeKey}`)
    .digest("base64url");
}

function assertAgentId(agentId: string): void {
  if (!isAgentId(agentId)) throw new Error(`Invalid Agent ID: ${agentId}`);
}
