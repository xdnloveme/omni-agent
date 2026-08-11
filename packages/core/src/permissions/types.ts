export type PermissionMode = "standard" | "supervised";

export type PermissionRisk =
  | "read"
  | "write"
  | "execute"
  | "external_read"
  | "external"
  | "destructive"
  | "privileged"
  | "unknown";

export interface PermissionPresentation {
  title: string;
  detail?: string;
  reason: string;
}

export interface PermissionAssessment {
  risk: PermissionRisk;
  enforcement: "policy" | "hard_deny";
  reasons: readonly string[];
  presentation: PermissionPresentation;
  ruleIds: readonly string[];
}

export interface PermissionContext {
  cwd: string;
  agentId: string;
  toolIdentity: string;
  toolCallId: string;
  signal?: AbortSignal;
}

export type ToolPermissionDescriptor = (
  | { kind: "static"; risk: "read" | "execute"; reason: string }
  | {
      kind: "dynamic";
      assess(
        input: Record<string, unknown>,
        context: PermissionContext,
      ): PermissionAssessment | Promise<PermissionAssessment>;
    }
) & { hiddenInputKeys?: readonly string[] };

export type ToolAuthorizationDescriptor =
  | ({ kind: "trusted"; reason: string } & { hiddenInputKeys?: readonly string[] })
  | ToolPermissionDescriptor;

export type PermissionPolicyDecision =
  | { outcome: "allow"; reason: string }
  | { outcome: "ask"; reason: string; canAllowAlways: boolean }
  | { outcome: "deny"; reason: string };

export interface PermissionPolicyContext {
  agentId: string;
  toolIdentity: string;
  toolName: string;
  mode: PermissionMode;
  assessment: PermissionAssessment;
}

export interface ApprovalRequest {
  agentId: string;
  toolCallId: string;
  toolIdentity: string;
  toolName: string;
  risk: PermissionRisk;
  presentation: PermissionPresentation;
  canAllowAlways: boolean;
}

export type ApprovalResponse = "allow_once" | "allow_always" | "deny";

export type PermissionDecisionSource = "policy" | "automatic_approval" | "user" | "hard_stop";

export interface PermissionRequestedEvent {
  agentId: string;
  toolIdentity: string;
  toolName: string;
  risk: PermissionRisk;
  ruleIds: readonly string[];
  timestamp: number;
}

export interface PermissionResolvedEvent extends PermissionRequestedEvent {
  outcome: "allow" | "deny";
  source: PermissionDecisionSource;
}
