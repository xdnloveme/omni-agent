import chalk from "chalk";
import type { Command } from "@omni-agent/core";
import type { AgentApplication } from "@omni-agent/app";

export function createPermissionsCommand(app: AgentApplication): Command {
  return {
    name: "permissions",
    description: "Manage permission mode and automatic tool approvals",
    async execute(ctx) {
      if (!ctx.tui.select) throw new Error("Permission settings require an interactive TUI");
      const mode = await app.getPermissionMode();
      const approvals = await app.listAlwaysApprovedTools();
      const actionResult = await ctx.tui.select({
        title: "Permissions",
        detail: `Agent: ${app.agentId}\nMode: ${mode}`,
        items: [
          {
            value: "mode",
            label: "Change mode",
            description: "Choose standard or supervised behavior",
          },
          ...approvals.map((tool) => ({
            value: `revoke:${tool.toolIdentity}`,
            label: `Revoke ${tool.toolName}`,
            description: tool.toolIdentity,
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
        const selectedResult = await ctx.tui.select({
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
          ctx.tui.sink.line(chalk.green(`Permission mode changed to ${selected}.`));
        }
      } else if (action === "clear") {
        await app.clearAlwaysApprovedTools();
        ctx.tui.sink.line(chalk.green("Automatic tool approvals cleared."));
      } else if (action.startsWith("revoke:")) {
        await app.revokeAlwaysApprovedTool(action.slice("revoke:".length));
        ctx.tui.sink.line(chalk.green("Automatic tool approval revoked."));
      }
      ctx.tui.sink.spacer();
    },
  };
}
