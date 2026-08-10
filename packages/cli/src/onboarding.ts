import { select } from "@inquirer/prompts";
import chalk from "chalk";
import type {
  ConfigService,
  ModelSelection,
  ModelService,
  ResolvedModelConfiguration,
} from "@omni-agent/app";
import { selectModel } from "./models/select-model";
import { createAuthInteraction } from "./models/auth-interaction";

export interface OnboardingResult {
  selection: ModelSelection;
}

export async function runOnboarding(modelService: ModelService): Promise<OnboardingResult> {
  console.log();
  console.log(chalk.bold("  Welcome to omni-agent"));
  console.log(chalk.dim("  Let's set up your model provider.\n"));

  const selection = await selectModel(modelService, async (providerId) => {
    if (await modelService.isConfigured(providerId)) return;
    const methods = modelService.getAuthMethods(providerId);
    const interactive = methods.filter((method) => method.interactive);
    if (interactive.length === 0) {
      throw new Error(
        `Provider ${providerId} requires ambient credentials (${methods.map((method) => method.label).join(", ")})`,
      );
    }
    const method =
      interactive.length === 1
        ? interactive[0]
        : await select({
            message: "Select an authentication method",
            choices: interactive.map((item) => ({ name: item.label, value: item })),
          });
    await modelService.login(providerId, method.type, createAuthInteraction());
    if (!(await modelService.isConfigured(providerId))) {
      throw new Error(`Authentication did not configure provider: ${providerId}`);
    }
  });
  const resolved = await modelService.resolve(selection);
  const configured = await modelService.isConfigured(resolved.providerId);

  console.log();
  console.log(chalk.green("  ✓ Configuration ready."));
  console.log(chalk.dim(`    Provider: ${selection.vendorId}/${selection.connectionId}`));
  console.log(chalk.dim(`    Model: ${selection.modelId}`));
  console.log(
    chalk.dim(
      `    Credential: ${configured?.source ?? configured?.type ?? "system credential manager"}`,
    ),
  );
  console.log();
  return { selection };
}

export async function persistOnboardingSelection(
  configService: ConfigService,
  agentId: string,
  selection: ModelSelection,
  current: ResolvedModelConfiguration | null,
): Promise<void> {
  if (current?.kind === "agent") {
    await configService.saveAgentModel(agentId, selection, { scope: current.scope });
    return;
  }
  await configService.saveSharedModel(selection);
}
