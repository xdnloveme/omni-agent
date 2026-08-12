import {
  sanitizePermissionLabel,
  type ApprovalBroker,
  type ApprovalRequest,
  type ApprovalResponse,
} from "@omni-agent/core";
import type { OmniTui } from "../interaction/tui/tui";

export class TuiApprovalBroker implements ApprovalBroker {
  constructor(private readonly tui: OmniTui) {}

  async request(request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalResponse> {
    this.tui.setStatus(`awaiting permission: ${request.toolName}`);
    const persistentOption = createPersistentApprovalOption(request);
    const selection = await this.tui.select(
      {
        title: "Permission required",
        tone:
          request.risk === "destructive" ||
          request.risk === "privileged" ||
          request.risk === "unknown"
            ? "danger"
            : "warning",
        detail: `${request.presentation.title}${request.presentation.detail ? `\n${request.presentation.detail}` : ""}`,
        message: `Risk: ${request.risk}\nReason: ${request.presentation.reason}`,
        items: [
          ...(persistentOption ? [persistentOption] : []),
          {
            value: "allow_once",
            label: "Allow once",
            description: "Approve only this call",
            tone: "positive",
          },
          {
            value: "deny",
            label: "Deny",
            description: "Return a permission error to the Agent",
            tone: "negative",
          },
        ],
      },
      signal,
    );
    if (selection.kind === "abort" || selection.kind === "shutdown") throw selection.error;
    this.tui.setStatus(`running: ${request.toolName}...`);
    if (selection.kind === "escape") return "deny";
    return selection.value === "allow_once" || selection.value === "allow_always"
      ? selection.value
      : "deny";
  }
}

function createPersistentApprovalOption(request: ApprovalRequest) {
  const scopes = request.persistentApprovals;
  if (!scopes?.length) return undefined;
  const allExecutables = scopes.every((scope) => scope.kind === "bash_executable");
  return {
    value: "allow_always",
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
