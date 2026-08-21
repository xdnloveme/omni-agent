import type { Command } from "@omni-agent/core";
import type { AgentApplication } from "@omni-agent/app";
import type { TextPresentationPort } from "../host-services";

export function createPermissionsCommand(
  app: AgentApplication,
  text: TextPresentationPort,
): Command {
  return {
    name: "permissions",
    description: "Manage permission mode and persistent approvals",
    async execute(ctx) {
      const mode = await app.getPermissionMode();
      const approvals = await app.listPersistentApprovals();
      const actionResult = await ctx.interaction.select({
        title: "Permissions",
        detail: `Agent: ${app.agentId}\nMode: ${mode}`,
        items: [
          {
            value: "mode",
            label: "Change mode",
            description: "Choose standard or supervised behavior",
          },
          ...approvals.map((grant) => ({
            value: `revoke:${grant.id}`,
            label: `Revoke ${grant.label}`,
            description: `${grant.toolName} · ${grant.scopeKind}`,
          })),
          ...(approvals.length
            ? [
                {
                  value: "clear",
                  label: "Clear all automatic approvals",
                  description: `Remove ${approvals.length} approval(s) for this Agent`,
                },
              ]
            : []),
        ],
      });
      if (actionResult.kind === "abort" || actionResult.kind === "shutdown")
        throw actionResult.error;
      if (actionResult.kind === "escape") return;
      const action = actionResult.value;
      if (action === "mode") {
        const selectedResult = await ctx.interaction.select({
          title: "Permission mode",
          detail: `Agent: ${app.agentId}`,
          items: [
            { value: "standard", label: "Standard", description: "Allow routine workspace writes" },
            {
              value: "supervised",
              label: "Supervised",
              description: "Ask before writes and execution",
            },
          ],
        });
        if (selectedResult.kind === "abort" || selectedResult.kind === "shutdown")
          throw selectedResult.error;
        const selected = selectedResult.kind === "selected" ? selectedResult.value : undefined;
        if (selected === "standard" || selected === "supervised") {
          await app.setPermissionMode(selected);
          ctx.interaction.line(text.success(`Permission mode changed to ${selected}.`));
        }
      } else if (action === "clear") {
        await app.clearPersistentApprovals();
        ctx.interaction.line(text.success("Persistent approvals cleared."));
      } else if (action.startsWith("revoke:")) {
        await app.revokePersistentApproval(action.slice("revoke:".length));
        ctx.interaction.line(text.success("Persistent approval revoked."));
      }
      ctx.interaction.spacer();
    },
  };
}
