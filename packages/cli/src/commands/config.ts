import chalk from "chalk";
import type { Command } from "@omni-agent/core";
import type { AgentApplication } from "@omni-agent/app";
import { runOnboarding } from "../onboarding";

export function createConfigCommand(app: AgentApplication): Command {
  return {
    name: "config",
    description: "Reconfigure model provider and credential",
    async execute(ctx) {
      ctx.tui.pause();
      let updated = false;
      try {
        const result = await runOnboarding(app.modelService, { persist: false });
        await app.setModel(result.config.model);
        updated = true;
      } catch (error) {
        console.error(
          chalk.red(
            `Configuration failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      } finally {
        ctx.tui.resume();
      }
      if (updated)
        ctx.tui.sink.line(
          chalk.green(`Configuration updated. Using ${app.modelSelection.vendorId} now.`),
        );
      ctx.tui.sink.spacer();
    },
  };
}
