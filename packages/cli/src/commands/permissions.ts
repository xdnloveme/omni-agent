import {
  networkTargetFromUrl,
  type Command,
  type CommandInteractionPort,
  type ExecutionMode,
} from "@omni-agent/core";
import type { AgentApplication } from "@omni-agent/app";
import type { TextPresentationPort } from "../host-services";

export function createPermissionsCommand(
  app: AgentApplication,
  text: TextPresentationPort,
): Command {
  return {
    name: "permissions",
    description: "Manage workspace execution boundaries",
    async execute(ctx) {
      if (ctx.args.trim()) {
        const [area, action, ...urls] = ctx.args.trim().split(/\s+/);
        if (area !== "network" || action !== "add" || urls.length === 0)
          throw new Error("Usage: /permissions network add <http(s) URL> [URL ...]");
        await app.addApprovedNetworkTargets(urls.map(networkTargetFromUrl));
        ctx.interaction.line(
          text.success(
            "Saved network targets for this workspace and Agent. Controlled calls reuse them without further prompts.",
          ),
        );
        return;
      }
      const settings = await app.getExecutionSettings();
      const result = await ctx.interaction.select({
        title: "Workspace execution",
        detail: `Agent: ${app.agentId}\nMode: ${settings.mode}\nApproved network targets: ${settings.approvedNetworkTargets.length}\nApproved roots: ${settings.approvedFilesystemRoots.length}`,
        items: [
          {
            value: "mode",
            label: "Change execution mode",
            description: "Choose controlled, autonomous, or unrestricted execution",
          },
          ...(settings.approvedFilesystemRoots.length > 0
            ? [
                {
                  value: "roots",
                  label: "Manage approved roots",
                  description: "Review or revoke controlled-mode filesystem access",
                },
              ]
            : []),
          {
            value: "network",
            label: "Manage approved network targets",
            description: "Configure once; reuse approved public, private, and local targets",
          },
        ],
      });
      if (result.kind === "abort" || result.kind === "shutdown") throw result.error;
      if (result.kind !== "selected") return;
      if (result.value === "network") {
        await manageApprovedNetworkTargets(
          app,
          ctx.interaction,
          text,
          settings.approvedNetworkTargets,
        );
      } else if (result.value === "mode") {
        const mode = await selectMode(ctx.interaction, app.agentId);
        if (!mode || mode === settings.mode) return;
        if (mode === "unrestricted" && !(await confirmUnrestricted(ctx.interaction))) return;
        await app.setExecutionMode(mode);
        ctx.interaction.line(text.success(`Execution mode changed to ${mode}.`));
      } else if (result.value === "roots") {
        await manageApprovedRoots(app, ctx.interaction, text, settings.approvedFilesystemRoots);
      }
      ctx.interaction.spacer();
    },
  };
}

async function manageApprovedNetworkTargets(
  app: AgentApplication,
  interaction: CommandInteractionPort,
  text: TextPresentationPort,
  targets: Awaited<ReturnType<AgentApplication["getExecutionSettings"]>>["approvedNetworkTargets"],
): Promise<void> {
  const result = await interaction.select({
    title: "Approved network targets",
    detail:
      "Add targets: /permissions network add http://localhost:3000 https://example.com\nSaved per workspace and Agent. Revoking access affects future tool calls only.",
    items: [
      ...targets.map((target, index) => ({
        value: `target:${index}`,
        label: `${target.scheme}://${target.host}:${target.port}`,
        description: "Exact scheme, host, and port",
      })),
      {
        value: "clear",
        label: "Clear all approved targets",
        description: "Require consent for every future network destination",
      },
    ],
  });
  if (result.kind === "abort" || result.kind === "shutdown") throw result.error;
  if (result.kind !== "selected") return;
  if (result.value === "clear") {
    await app.clearApprovedNetworkTargets();
    interaction.line(text.success("Cleared approved network targets."));
    return;
  }
  const index = Number(result.value.slice("target:".length));
  const target = targets[index];
  if (!target) return;
  await app.revokeApprovedNetworkTarget(target);
  interaction.line(
    text.success(`Revoked network access to ${target.scheme}://${target.host}:${target.port}.`),
  );
}

async function manageApprovedRoots(
  app: AgentApplication,
  interaction: CommandInteractionPort,
  text: TextPresentationPort,
  roots: Awaited<ReturnType<AgentApplication["getExecutionSettings"]>>["approvedFilesystemRoots"],
): Promise<void> {
  const result = await interaction.select({
    title: "Approved filesystem roots",
    detail: "Revoking access affects future tool calls only.",
    items: [
      ...roots.map((root, index) => ({
        value: `root:${index}`,
        label: root.path,
        description: `${root.access === "read_write" ? "Read/write" : "Read"} · ${root.scope}`,
      })),
      {
        value: "clear",
        label: "Clear all approved roots",
        description: "Return controlled mode to the primary workspace boundary",
      },
    ],
  });
  if (result.kind === "abort" || result.kind === "shutdown") throw result.error;
  if (result.kind !== "selected") return;
  if (result.value === "clear") {
    await app.clearApprovedFilesystemRoots();
    interaction.line(text.success("Cleared approved filesystem roots."));
    return;
  }
  const index = Number(result.value.slice("root:".length));
  const root = roots[index];
  if (!root) return;
  await app.revokeApprovedFilesystemRoot(root);
  interaction.line(text.success(`Revoked filesystem access to ${root.path}.`));
}

async function selectMode(
  interaction: CommandInteractionPort,
  agentId: string,
): Promise<ExecutionMode | undefined> {
  const result = await interaction.select({
    title: "Execution mode",
    detail: `Agent: ${agentId}`,
    items: [
      {
        value: "controlled",
        label: "Controlled",
        description: "Workspace sandbox; reuse configured filesystem and network permissions",
      },
      {
        value: "autonomous",
        label: "Autonomous",
        description:
          "Automatically authorize per-call filesystem and network scope; keep the sandbox",
      },
      {
        value: "unrestricted",
        label: "Unrestricted",
        description: "Run directly on the host without sandbox restrictions",
      },
    ],
  });
  if (result.kind === "abort" || result.kind === "shutdown") throw result.error;
  return result.kind === "selected" ? (result.value as ExecutionMode) : undefined;
}

async function confirmUnrestricted(interaction: CommandInteractionPort): Promise<boolean> {
  const result = await interaction.select({
    title: "Unrestricted host execution",
    detail: "Commands will run directly on the host without sandbox restrictions.",
    items: [
      {
        value: "cancel",
        label: "Keep current mode",
        description: "Return without changing execution mode",
      },
      {
        value: "confirm",
        label: "Enable unrestricted mode",
        description: "Allow direct host filesystem, process, and network access",
      },
    ],
  });
  if (result.kind === "abort" || result.kind === "shutdown") throw result.error;
  return result.kind === "selected" && result.value === "confirm";
}
