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
        ctx.tui.sink.line(chalk.green(`Reloaded ${result.skills.length} skills.`));
        if (result.diagnostics.length > 0) {
          ctx.tui.sink.line(chalk.yellow(`${result.diagnostics.length} diagnostics. Run /skills diagnostics for details.`));
        }
        ctx.tui.sink.spacer();
        return;
      }

      if (subcommand === "diagnostics") {
        const diagnostics = skillRegistry.diagnostics();
        if (diagnostics.length === 0) {
          ctx.tui.sink.line(chalk.green("No skill diagnostics."));
          ctx.tui.sink.spacer();
          return;
        }
        ctx.tui.sink.line(chalk.bold("Skill diagnostics"));
        for (const diagnostic of diagnostics) {
          ctx.tui.sink.line(`${diagnostic.type === "error" ? chalk.red("error") : chalk.yellow("warning")} ${diagnostic.code}: ${diagnostic.message}`);
          ctx.tui.sink.line(chalk.dim(`  ${diagnostic.path}`));
        }
        ctx.tui.sink.spacer();
        return;
      }

      const skills = skillRegistry.list();
      if (skills.length === 0) {
        ctx.tui.sink.line(chalk.dim("No skills loaded."));
        ctx.tui.sink.spacer();
        return;
      }

      ctx.tui.sink.line(chalk.bold("Available skills"));
      for (const skill of skills) {
        const flags = [
          skill.source.scope,
          skill.userInvocable ? "slash" : null,
          skill.disableModelInvocation ? "hidden" : null,
        ].filter(Boolean).join(", ");
        ctx.tui.sink.line(`${chalk.cyan(skill.name)} ${chalk.dim(`[${flags}]`)}`);
        ctx.tui.sink.line(chalk.dim(`  ${skill.description}`));
      }
      ctx.tui.sink.spacer();
    },
  };
}
