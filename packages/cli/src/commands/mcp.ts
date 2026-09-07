import type { Command } from "@omni-agent/core";
import type { AgentApplication } from "@omni-agent/app";

export function createMcpCommand(app: AgentApplication): Command {
  return {
    name: "mcp",
    description: "Manage MCP integrations for this workspace and Agent",
    async execute({ interaction }) {
      for (;;) {
        const servers = app.listMcpServers();
        if (servers.length === 0) {
          interaction.line("No MCP servers configured. Define mcp.servers in omni.config.json.");
          return;
        }
        const selection = await interaction.select({
          title: "MCP integrations",
          detail: `Agent: ${app.agentId}`,
          items: servers.map((server) => ({
            value: server.id,
            label: `${server.enabled ? "[ON]" : "[OFF]"} ${server.id}`,
            description: `${server.status} · ${server.toolCount} tools${server.error ? ` · ${server.error}` : ""}`,
          })),
        });
        if (selection.kind === "abort" || selection.kind === "shutdown") throw selection.error;
        if (selection.kind !== "selected") return;
        const server = servers.find((entry) => entry.id === selection.value)!;
        const action = await interaction.select({
          title: server.id,
          detail: server.error ?? `${server.status} · ${server.toolCount} tools`,
          items: [
            { value: "toggle", label: server.enabled ? "Turn off" : "Turn on" },
            ...(server.enabled ? [{ value: "retry", label: "Reconnect / refresh tools" }] : []),
          ],
        });
        if (action.kind === "abort" || action.kind === "shutdown") throw action.error;
        if (action.kind !== "selected") continue;
        if (action.value === "retry") await app.retryMcp(server.id);
        else await app.setMcpEnabled(server.id, !server.enabled);
      }
    },
  };
}
