import type { Command, SkillRegistry } from "@omni-agent/core";
import type { TextPresentationPort } from "../host-services";

export function createSkillsCommand(
  skillRegistry: SkillRegistry,
  text: TextPresentationPort,
  onReload?: () => void | Promise<void>,
): Command {
  return {
    name: "skills",
    description: "List, reload, or inspect loaded skills",
    async execute(ctx) {
      const subcommand = ctx.args.trim().toLowerCase();
      if (subcommand === "reload") {
        const result = await skillRegistry.reload();
        await onReload?.();
        ctx.interaction.line(text.success(`Reloaded ${result.skills.length} skills.`));
        if (result.diagnostics.length > 0) {
          ctx.interaction.line(
            text.warning(
              `${result.diagnostics.length} diagnostics. Run /skills diagnostics for details.`,
            ),
          );
        }
        ctx.interaction.spacer();
        return;
      }

      if (subcommand === "diagnostics") {
        const diagnostics = skillRegistry.diagnostics();
        if (diagnostics.length === 0) {
          ctx.interaction.line(text.success("No skill diagnostics."));
          ctx.interaction.spacer();
          return;
        }
        ctx.interaction.line(text.heading("Skill diagnostics"));
        for (const diagnostic of diagnostics) {
          ctx.interaction.line(
            `${diagnostic.type === "error" ? text.error("error") : text.warning("warning")} ${diagnostic.code}: ${diagnostic.message}`,
          );
          ctx.interaction.line(text.muted(`  ${diagnostic.path}`));
        }
        ctx.interaction.spacer();
        return;
      }

      const skills = skillRegistry.list();
      if (skills.length === 0) {
        ctx.interaction.line(text.muted("No skills loaded."));
        ctx.interaction.spacer();
        return;
      }

      ctx.interaction.line(text.heading("Available skills"));
      for (const skill of skills) {
        const flags = [
          skill.source.scope,
          skill.userInvocable ? "slash" : null,
          skill.disableModelInvocation ? "hidden" : null,
        ]
          .filter(Boolean)
          .join(", ");
        ctx.interaction.line(`${text.accent(skill.name)} ${text.muted(`[${flags}]`)}`);
        ctx.interaction.line(text.muted(`  ${skill.description}`));
      }
      ctx.interaction.spacer();
    },
  };
}
