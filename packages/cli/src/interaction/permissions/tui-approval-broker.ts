import {
  sanitizePermissionLabel,
  type ApprovalBroker,
  type ApprovalRequest,
  type ApprovalResponse,
  type InteractionSurfacePort,
} from "@omni-agent/core";

export class TuiApprovalBroker implements ApprovalBroker {
  constructor(private readonly surface: InteractionSurfacePort) {}

  async request(request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalResponse> {
    const persistentOption = createPersistentApprovalOption(request);
    const fieldId = "approval";
    const selection = await this.surface.request(
      {
        requestId: crypto.randomUUID(),
        title: "Permission required",
        tone:
          request.risk === "destructive" ||
          request.risk === "privileged" ||
          request.risk === "unknown"
            ? "danger"
            : "warning",
        detail: `${request.presentation.title}${request.presentation.detail ? `\n${request.presentation.detail}` : ""}`,
        message: `Risk: ${request.risk}\nReason: ${request.presentation.reason}`,
        status: `awaiting permission: ${request.toolName}`,
        completionStatus: `running: ${request.toolName}...`,
        fields: [
          {
            type: "single",
            id: fieldId,
            label: "Permission decision",
            options: [
              ...(persistentOption ? [persistentOption] : []),
              {
                id: "allow_once",
                label: "Allow once",
                description: "Approve only this call",
                tone: "positive",
              },
              {
                id: "deny",
                label: "Deny",
                description: "Return a permission error to the Agent",
                tone: "negative",
              },
            ],
          },
        ],
        completion: { type: "on_select", fieldId },
      },
      signal,
    );
    if (selection.kind === "dismissed") return "deny";
    const value = selection.values[fieldId];
    return value?.type === "single" &&
      (value.optionId === "allow_once" || value.optionId === "allow_always")
      ? value.optionId
      : "deny";
  }
}

function createPersistentApprovalOption(request: ApprovalRequest) {
  const scopes = request.persistentApprovals;
  if (!scopes?.length) return undefined;
  const allExecutables = scopes.every((scope) => scope.kind === "bash_executable");
  return {
    id: "allow_always",
    label:
      scopes.length === 1
        ? scopes[0]!.label
        : allExecutables
          ? "Always trust listed executables"
          : "Always approve all listed operations",
    description:
      scopes.length === 1
        ? `Save this approval for ${request.agentId}`
        : sanitizePermissionLabel(
            `${scopes.length} missing approvals: ${scopes.map((scope) => scope.label).join(" · ")}`,
          ),
    tone: "positive" as const,
  };
}
