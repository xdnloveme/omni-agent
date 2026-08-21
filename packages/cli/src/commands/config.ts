import type { Command } from "@omni-agent/core";
import type { AgentApplication } from "@omni-agent/app";
import type { OnboardingInteractionPort, TextPresentationPort } from "../host-services";
import { runOnboarding } from "../onboarding";

export function createConfigCommand(
  app: AgentApplication,
  createOnboardingInteraction: () => OnboardingInteractionPort,
  text: TextPresentationPort,
): Command {
  return {
    name: "config",
    description: "Reconfigure model provider and credential",
    async execute(ctx) {
      ctx.interaction.pause();
      let updated = false;
      try {
        const interaction = createOnboardingInteraction();
        const action = await interaction.select(
          "Choose model configuration",
          [
            {
              id: "agent",
              label: `Set a model for ${app.agentId}`,
              description: "Only this Agent uses the selected model",
            },
            {
              id: "use-shared",
              label: "Use the shared default model",
              description: "Remove this Agent's model override",
            },
            {
              id: "shared",
              label: "Change the shared default model",
              description: "Affects Agents without their own override",
            },
          ],
          { loop: true },
        );
        if (action === "use-shared") {
          await app.useSharedModel();
        } else {
          const result = await runOnboarding(app.modelService, interaction);
          if (action === "agent") await app.setAgentModel(result.selection);
          else await app.setSharedModel(result.selection);
        }
        updated = true;
      } catch (error) {
        ctx.interaction.line(
          text.error(
            `Configuration failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      } finally {
        ctx.interaction.resume();
      }
      if (updated) {
        ctx.interaction.line(
          text.success(`Global configuration updated. Using ${app.modelSelection.vendorId} now.`),
        );
      }
      ctx.interaction.spacer();
    },
  };
}
