import chalk from "chalk";
import { select } from "@inquirer/prompts";
import type { Command } from "@omni-agent/core";
import type { AgentApplication } from "@omni-agent/app";
import { runOnboarding } from "../onboarding";

export function createConfigCommand(app: AgentApplication): Command {
  return {
    name: "config",
    description: "Reconfigure model provider and credential",
    async execute(ctx) {
      ctx.interaction.pause();
      let updated = false;
      try {
        const action = await select({
          message: "Choose model configuration",
          choices: [
            {
              name: `Set a model for ${app.agentId}`,
              value: "agent" as const,
              description: "Only this Agent uses the selected model",
            },
            {
              name: "Use the shared default model",
              value: "use-shared" as const,
              description: "Remove this Agent's model override",
            },
            {
              name: "Change the shared default model",
              value: "shared" as const,
              description: "Affects Agents without their own override",
            },
          ],
        });
        if (action === "use-shared") {
          await app.useSharedModel();
        } else {
          const result = await runOnboarding(app.modelService);
          if (action === "agent") await app.setAgentModel(result.selection);
          else await app.setSharedModel(result.selection);
        }
        updated = true;
      } catch (error) {
        console.error(
          chalk.red(
            `Configuration failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      } finally {
        ctx.interaction.resume();
      }
      if (updated) {
        ctx.interaction.line(
          chalk.green(`Global configuration updated. Using ${app.modelSelection.vendorId} now.`),
        );
      }
      ctx.interaction.spacer();
    },
  };
}
