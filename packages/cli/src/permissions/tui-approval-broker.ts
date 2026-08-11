import type { ApprovalBroker, ApprovalRequest, ApprovalResponse } from "@omni-agent/core";
import type { OmniTui } from "../interaction/tui/tui";

export class TuiApprovalBroker implements ApprovalBroker {
  constructor(private readonly tui: OmniTui) {}

  async request(request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalResponse> {
    this.tui.setStatus(`awaiting permission: ${request.toolName}`);
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
          {
            value: "allow_once",
            label: "Allow once",
            description: "Approve only this call",
            tone: "positive",
          },
          ...(request.canAllowAlways
            ? [
                {
                  value: "allow_always",
                  label: `Always approve routine ${request.toolName} operations`,
                  description: `Automatically approve routine ${request.toolName} calls for ${request.agentId}`,
                  tone: "positive" as const,
                },
              ]
            : []),
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
