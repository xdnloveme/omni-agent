import {
  AgentFactory,
  ConfigService,
  createModelService,
  resolveWorkspaceContext,
} from "@omni-agent/app";
import { loadAgentBlueprint } from "../agents/agent-blueprint-loader";
import { createCommandRegistry, HOST_COMMAND_NAMES } from "../commands/index";
import type { CliHostServices, HostTermination } from "../host-services";
import { persistOnboardingSelection, runOnboarding } from "../onboarding";
import { SkillCliController } from "../skills";
import { parseSlashCommandInput } from "./slash-command-input";

const INITIAL_HISTORY_TURNS = 10;

export async function runAgentMode(
  agentId: string,
  host: CliHostServices,
  options: { readonly trace: boolean } = { trace: false },
): Promise<HostTermination> {
  const workspace = await resolveWorkspaceContext(process.cwd());
  const blueprint = await loadAgentBlueprint(agentId);
  const configService = new ConfigService({ cwd: workspace.root });
  const resolvedConfiguration = await configService.resolveModelConfiguration(agentId);
  const selection = resolvedConfiguration?.selection ?? null;
  for (const diagnostic of configService.diagnostics) {
    console.warn(host.text.warning(`Configuration ${diagnostic.code}: ${diagnostic.message}`));
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
      const result = await runOnboarding(modelService, host.createOnboardingInteraction());
      await persistOnboardingSelection(
        configService,
        agentId,
        result.selection,
        resolvedConfiguration,
      );
    }

    const consoleView = host.createAgentConsole({ workspaceRoot: workspace.root });
    let instance: Awaited<ReturnType<AgentFactory["create"]>> | undefined;
    try {
      instance = await new AgentFactory({
        workspace,
        configService,
        modelService,
        interactionSurface: consoleView.interactionSurface,
        approvalBroker: consoleView.approvalBroker,
        reservedCommandNames: HOST_COMMAND_NAMES,
      }).create(blueprint);
      const app = instance.application;
      const skillCapability = instance.capabilities.skills;
      if (options.trace) instance.trace?.control.start();

      const registry = createCommandRegistry(app, host, instance.trace);
      let activeAbort: AbortController | null = null;
      let running = false;

      registry.register({
        name: "new",
        description: "Start a new conversation session",
        async execute() {
          await app.newSession();
          consoleView.clearSessionHistory();
          consoleView.writeNotice("New session started.", "success");
        },
      });
      registry.register({
        name: "clear",
        description: "Clear current session history",
        async execute() {
          await app.clearSession();
          consoleView.clearSessionHistory();
          consoleView.writeNotice("Session history cleared.", "success");
        },
      });

      const skillController = skillCapability
        ? new SkillCliController({
            skillRuntime: skillCapability.runtime,
            commandRegistry: registry,
            console: consoleView,
            text: host.text,
            refreshInstructions: () => app.refreshInstructions(),
          })
        : undefined;
      skillController?.registerCommands();
      if (skillController) skillController.refreshAutocomplete();
      else consoleView.setCommandCatalog(registry.list());

      async function runUserInput(displayInput: string, modelInput: string): Promise<void> {
        running = true;
        activeAbort = new AbortController();
        consoleView.appendUserMessage(displayInput);
        consoleView.setStatus({ text: "thinking...", tone: "active" });
        consoleView.setActivity("Thinking…");
        const presentation = consoleView.createRunPresentation({
          skills: Boolean(skillController),
        });
        try {
          await app.run(modelInput, presentation.callbacks(), activeAbort.signal);
        } catch (error) {
          if (!(error instanceof Error && error.name === "AbortError")) {
            consoleView.writeNotice(
              `Error: ${error instanceof Error ? error.message : String(error)}`,
              "error",
            );
          }
        } finally {
          presentation.cancelPending();
          consoleView.setActivity(null);
          running = false;
          activeAbort = null;
          consoleView.setStatus({ text: "omni-agent | Ctrl+C to exit", tone: "neutral" });
        }
      }

      consoleView.bindHandlers({
        onInterrupt() {
          if (!running || !activeAbort) return false;
          activeAbort.abort();
          consoleView.writeNotice("(aborted)", "warning");
          consoleView.setStatus({ text: "aborting...", tone: "neutral" });
          return true;
        },
        async onSubmit(input) {
          if (running) return;
          const slashInput = parseSlashCommandInput(input);
          if (!slashInput) {
            await runUserInput(input, input);
            return;
          }

          const command = registry.get(slashInput.name);
          if (command) {
            consoleView.appendUserMessage(input);
            try {
              await command.execute({
                args: slashInput.args,
                interaction: consoleView.commandInteraction,
              });
            } catch (error) {
              if (!(error instanceof Error && error.name === "AbortError")) {
                consoleView.writeNotice(
                  `Command failed: ${error instanceof Error ? error.message : String(error)}`,
                  "error",
                );
              }
            }
            return;
          }

          if (skillController) {
            try {
              const preload = await skillController.resolveSlashPreload(input);
              if (preload) {
                await runUserInput(input, preload.modelInput);
                return;
              }
            } catch (error) {
              consoleView.appendUserMessage(input);
              consoleView.writeNotice(
                `Error reading skill: ${error instanceof Error ? error.message : String(error)}`,
                "error",
              );
              return;
            }
          }

          consoleView.appendUserMessage(input);
          consoleView.writeNotice("Unknown command. Type /help for available commands.", "warning");
        },
      });

      const restoredMessages = app.currentSessionSnapshot().messages;
      if (restoredMessages.length > 0) {
        consoleView.showSessionHistory(restoredMessages, {
          initialTurns: INITIAL_HISTORY_TURNS,
          agent: { id: instance.id },
        });
      } else {
        consoleView.showWelcome({ id: instance.id });
      }
      return await consoleView.start();
    } finally {
      consoleView.dispose();
      await instance?.dispose();
    }
  } finally {
    await modelService.dispose();
  }
}
