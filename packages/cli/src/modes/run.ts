import chalk from "chalk";

import {
  AgentFactory,
  ConfigService,
  createModelService,
  resolveWorkspaceContext,
} from "@omni-agent/app";
import { loadAgentBlueprint } from "../agents/agent-blueprint-loader";
import { createOmniTui } from "../interaction/tui/tui";
import { TuiInteractionSurface } from "../interaction/surface/tui-interaction-surface";
import { TuiCommandInteractionAdapter } from "../interaction/command-interaction-adapter";
import { persistOnboardingSelection, runOnboarding } from "../onboarding";
import { createCommandRegistry, HOST_COMMAND_NAMES } from "../commands/index";
import { SkillCliController } from "../skills";
import { TuiApprovalBroker } from "../interaction/permissions/tui-approval-broker";
import { SkillStreamPresenter } from "../presentation/skill-stream-presenter";
import { StreamPresentationRouter } from "../presentation/stream-presentation-router";
import { TranscriptHistoryPresenter } from "../presentation/transcript-history-presenter";
import type { TuiTermination } from "../interaction/tui/tui";
import { parseSlashCommandInput } from "./slash-command-input";

const INITIAL_HISTORY_TURNS = 10;

export async function runAgentMode(
  agentId: string,
  options: { readonly trace: boolean } = { trace: false },
): Promise<TuiTermination> {
  const workspace = await resolveWorkspaceContext(process.cwd());
  const blueprint = await loadAgentBlueprint(agentId);
  const configService = new ConfigService({ cwd: workspace.root });
  const resolvedConfiguration = await configService.resolveModelConfiguration(agentId);
  const selection = resolvedConfiguration?.selection ?? null;
  for (const diagnostic of configService.diagnostics) {
    console.warn(chalk.yellow(`Configuration ${diagnostic.code}: ${diagnostic.message}`));
  }
  const modelService = await createModelService({ cwd: workspace.root });
  try {
    let configured = false;
    if (selection) {
      try {
        const resolved = await modelService.resolve(selection);
        configured = Boolean(await modelService.isConfigured(resolved.providerId));
      } catch {
        configured = false;
      }
    }
    if (!selection || !configured) {
      const result = await runOnboarding(modelService);
      await persistOnboardingSelection(
        configService,
        agentId,
        result.selection,
        resolvedConfiguration,
      );
    }

    const tui = createOmniTui({ workspaceRoot: workspace.root });
    const interaction = new TuiInteractionSurface(tui);
    const instance = await new AgentFactory({
      workspace,
      configService,
      modelService,
      interactionSurface: interaction,
      approvalBroker: new TuiApprovalBroker(interaction),
      reservedCommandNames: HOST_COMMAND_NAMES,
    }).create(blueprint);
    const app = instance.application;
    const skillCapability = instance.capabilities.skills;
    if (options.trace) instance.trace?.control.start();

    const registry = createCommandRegistry(app, instance.trace);
    let activeAbort: AbortController | null = null;
    let running = false;
    const restoredMessages = app.currentSessionSnapshot().messages;
    const historyPresenter = new TranscriptHistoryPresenter(INITIAL_HISTORY_TURNS);
    let visibleHistoryTurns = INITIAL_HISTORY_TURNS;

    const renderSessionHistory = () => {
      const viewModel = {
        ...historyPresenter.present(restoredMessages, visibleHistoryTurns),
        header: {
          title: `omni-agent · ${instance.id}`,
          subtitle: "Session restored. Earlier conversation is shown below.",
        },
      };
      tui.setSessionHistory(
        viewModel,
        viewModel.hiddenTurnCount > 0
          ? () => {
              visibleHistoryTurns += INITIAL_HISTORY_TURNS;
              renderSessionHistory();
            }
          : undefined,
      );
    };

    const commandInteraction = new TuiCommandInteractionAdapter(tui, interaction);

    // Register /new command
    registry.register({
      name: "new",
      description: "Start a new conversation session",
      async execute(ctx) {
        await app.newSession();
        tui.clearSessionHistory();
        ctx.interaction.line(chalk.green("New session started."));
        ctx.interaction.spacer();
      },
    });

    // Register /clear command
    registry.register({
      name: "clear",
      description: "Clear current session history",
      async execute(ctx) {
        await app.clearSession();
        tui.clearSessionHistory();
        ctx.interaction.line(chalk.green("Session history cleared."));
        ctx.interaction.spacer();
      },
    });

    const skillController = skillCapability
      ? new SkillCliController({
          skillRuntime: skillCapability.runtime,
          commandRegistry: registry,
          tui,
          refreshInstructions: () => app.refreshInstructions(),
        })
      : undefined;
    skillController?.registerCommands();

    // Provide command list to TUI for Tab completion
    if (skillController) {
      skillController.refreshAutocomplete();
    } else {
      tui.setCommands(
        registry.list().map((command) => ({
          name: command.name,
          description: command.description,
        })),
      );
    }

    tui.onInterrupt = () => {
      if (!running || !activeAbort) return false;
      activeAbort.abort();
      tui.sink.line(chalk.yellow("(aborted)"));
      tui.sink.spacer();
      tui.setStatus(chalk.dim("aborting..."));
      return true;
    };

    tui.onSubmit = async (input: string) => {
      if (running) return;

      const slashInput = parseSlashCommandInput(input);
      if (slashInput) {
        const command = registry.get(slashInput.name);
        if (command) {
          tui.appendUserMessage(input);
          try {
            await command.execute({ args: slashInput.args, interaction: commandInteraction });
          } catch (error) {
            if (!(error instanceof Error && error.name === "AbortError")) {
              tui.sink.line(
                chalk.red(
                  `Command failed: ${error instanceof Error ? error.message : String(error)}`,
                ),
              );
              tui.sink.spacer();
            }
          }
          return;
        }

        if (skillController) {
          let explicitSkillPreload: Awaited<ReturnType<SkillCliController["resolveSlashPreload"]>> =
            null;
          try {
            explicitSkillPreload = await skillController.resolveSlashPreload(input);
          } catch (err) {
            tui.appendUserMessage(input);
            tui.sink.line(
              chalk.red(`Error reading skill: ${err instanceof Error ? err.message : String(err)}`),
            );
            tui.sink.spacer();
            return;
          }

          if (explicitSkillPreload) {
            await runUserInput(input, explicitSkillPreload.modelInput);
            return;
          }
        }

        tui.appendUserMessage(input);
        tui.sink.line(chalk.yellow("Unknown command. Type /help for available commands."));
        tui.sink.spacer();
        return;
      }

      await runUserInput(input, input);
    };

    async function runUserInput(displayInput: string, modelInput: string) {
      running = true;
      activeAbort = new AbortController();
      tui.appendUserMessage(displayInput);
      tui.setStatus(chalk.cyan("thinking..."));
      tui.startActivity("Thinking…");

      const skillPresenter = skillController ? new SkillStreamPresenter(tui) : undefined;
      const streamPresenter = new StreamPresentationRouter(tui, skillPresenter);

      try {
        await app.run(modelInput, streamPresenter.callbacks(), activeAbort.signal);
      } catch (err) {
        if (!(err instanceof Error && err.name === "AbortError")) {
          tui.sink.line(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
          tui.sink.spacer();
        }
      } finally {
        streamPresenter.cancelPending();
        tui.stopActivity();
        running = false;
        activeAbort = null;
        tui.setStatus(chalk.dim("omni-agent | Ctrl+C to exit"));
      }
    }

    if (restoredMessages.length > 0) {
      renderSessionHistory();
    } else {
      tui.sink.line(chalk.bold(`omni-agent · ${instance.id}`));
      tui.sink.line(
        chalk.dim("Type your request below. Session history is preserved across restarts."),
      );
      tui.sink.spacer();
    }

    try {
      return await tui.start();
    } finally {
      interaction.dispose();
      await instance.dispose();
    }
  } finally {
    await modelService.dispose();
  }
}
