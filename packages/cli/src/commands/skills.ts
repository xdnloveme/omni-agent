import chalk from "chalk";
import type { Command, SkillRegistry } from "@omni-agent/core";

export function createSkillsCommand(
  skillRegistry: SkillRegistry,
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
        ctx.interaction.line(chalk.green(`Reloaded ${result.skills.length} skills.`));
        if (result.diagnostics.length > 0) {
          ctx.interaction.line(
            chalk.yellow(
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
          ctx.interaction.line(chalk.green("No skill diagnostics."));
          ctx.interaction.spacer();
          return;
        }
        ctx.interaction.line(chalk.bold("Skill diagnostics"));
        for (const diagnostic of diagnostics) {
          ctx.interaction.line(
            `${diagnostic.type === "error" ? chalk.red("error") : chalk.yellow("warning")} ${diagnostic.code}: ${diagnostic.message}`,
          );
          ctx.interaction.line(chalk.dim(`  ${diagnostic.path}`));
        }
        ctx.interaction.spacer();
        return;
      }

      const skills = skillRegistry.list();
      if (skills.length === 0) {
        ctx.interaction.line(chalk.dim("No skills loaded."));
        ctx.interaction.spacer();
        return;
      }

      ctx.interaction.line(chalk.bold("Available skills"));
      for (const skill of skills) {
        const flags = [
          skill.source.scope,
          skill.userInvocable ? "slash" : null,
          skill.disableModelInvocation ? "hidden" : null,
        ]
          .filter(Boolean)
          .join(", ");
        ctx.interaction.line(`${chalk.cyan(skill.name)} ${chalk.dim(`[${flags}]`)}`);
        ctx.interaction.line(chalk.dim(`  ${skill.description}`));
      }
      ctx.interaction.spacer();
    },
  };
}
