import type {
  ApprovalRequest,
  ApprovalResponse,
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
  isToolAlwaysApproved(agentId: string, toolIdentity: string): Promise<boolean>;
  approveTool(agentId: string, toolIdentity: string, toolName: string): Promise<void>;
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
