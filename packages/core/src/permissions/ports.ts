import type {
  ApprovalRequest,
  ApprovalResponse,
  PermissionGrant,
  PermissionMode,
  PermissionPolicyContext,
  PermissionPolicyDecision,
  PermissionRequestedEvent,
  PermissionResolvedEvent,
} from "./types";

export interface PermissionPolicy {
  evaluate(
    context: PermissionPolicyContext,
  ): PermissionPolicyDecision | Promise<PermissionPolicyDecision>;
}

export interface ApprovalBroker {
  request(request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalResponse>;
}

export interface PermissionGrantStore {
  getMode(agentId: string): Promise<PermissionMode>;
  getGrantedScopeKeys(
    agentId: string,
    toolIdentity: string,
    scopeKeys: readonly string[],
  ): Promise<readonly string[]>;
  saveGrants(agentId: string, grants: readonly PermissionGrant[]): Promise<void>;
}

export interface PermissionObserver {
  onRequested?(event: PermissionRequestedEvent): void | Promise<void>;
  onResolved?(event: PermissionResolvedEvent): void | Promise<void>;
}

export class DenyApprovalBroker implements ApprovalBroker {
  async request(): Promise<ApprovalResponse> {
    return "deny";
  }
}
