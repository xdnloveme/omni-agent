import type {
  ConfigService,
  ModelSelection,
  ModelService,
  ResolvedModelConfiguration,
} from "@omni-agent/app";
import type { OnboardingInteractionPort } from "./host-services";
import { selectModel } from "./models/select-model";

export interface OnboardingResult {
  selection: ModelSelection;
}

export async function runOnboarding(
  modelService: ModelService,
  interaction: OnboardingInteractionPort,
): Promise<OnboardingResult> {
  interaction.showWelcome();
  const selection = await selectModel(
    modelService,
    async (providerId) => {
      if (await modelService.isConfigured(providerId)) return;
      const methods = modelService.getAuthMethods(providerId);
      const interactive = methods.filter((method) => method.interactive);
      if (interactive.length === 0) {
        throw new Error(
          `Provider ${providerId} requires ambient credentials (${methods.map((method) => method.label).join(", ")})`,
        );
      }
      const selectedMethod =
        interactive.length === 1
          ? interactive[0]!.type
          : await interaction.selectAuthenticationMethod(
              interactive.map((item) => ({ id: item.type, label: item.label })),
            );
      const method = interactive.find((candidate) => candidate.type === selectedMethod);
      if (!method) throw new Error(`Unknown authentication method for ${providerId}`);
      await modelService.login(providerId, method.type, interaction.createAuthInteraction());
      if (!(await modelService.isConfigured(providerId))) {
        throw new Error(`Authentication did not configure provider: ${providerId}`);
      }
    },
    interaction,
  );
  const resolved = await modelService.resolve(selection);
  const configured = await modelService.isConfigured(resolved.providerId);
  interaction.showConfigurationReady({
    provider: `${selection.vendorId}/${selection.connectionId}`,
    model: selection.modelId,
    credential: configured?.source ?? configured?.type ?? "system credential manager",
  });
  return { selection };
}

export async function persistOnboardingSelection(
  configService: ConfigService,
  agentId: string,
  selection: ModelSelection,
  current: ResolvedModelConfiguration | null,
): Promise<void> {
  if (current?.kind === "agent") {
    await configService.saveAgentModel(agentId, selection, { scope: "global" });
    return;
  }
  await configService.saveSharedModel(selection, { scope: "global" });
}
