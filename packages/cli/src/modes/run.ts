import {
  AgentFactory,
  ConfigService,
  createModelService,
  resolveWorkspaceContext,
} from "@omni-agent/app";
import { loadAgentPackage } from "../agents/agent-package-loader";
import { createCommandRegistry, HOST_COMMAND_NAMES } from "../commands/index";
import type { CliHostServices, HostTermination } from "../host-services";
import { persistOnboardingSelection, runOnboarding } from "../onboarding";
import { SkillCliController } from "../skills";
import { ActiveAgentRun } from "../runtime/active-agent-run";
import { parseSlashCommandInput } from "./slash-command-input";

const INITIAL_HISTORY_TURNS = 10;

export async function runAgentMode(
  agentId: string,
  host: CliHostServices,
  options: { readonly trace: boolean } = { trace: false },
): Promise<HostTermination> {
  const workspace = await resolveWorkspaceContext(host.runtime.cwd);
  const agentPackage = await loadAgentPackage(agentId, {
    resolutionBase: host.runtime.cliEntry,
    agentPackagesDirectory: host.runtime.agentPackagesDirectory,
  });
  const configService = new ConfigService({
    cwd: workspace.root,
    globalDirectory: host.runtime.globalDirectory,
  });
  const resolvedConfiguration = await configService.resolveModelConfiguration(agentId);
  const selection = resolvedConfiguration?.selection ?? null;
  for (const diagnostic of configService.diagnostics) {
    host.output.stderr(
      `${host.text.warning(`Configuration ${diagnostic.code}: ${diagnostic.message}`)}\n`,
    );
  }

  const modelService = await createModelService({
    cwd: workspace.root,
    globalDirectory: host.runtime.globalDirectory,
  });
  return runAgentModeScope(async () => {
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
    const activeRun = new ActiveAgentRun();
    let instance: Awaited<ReturnType<AgentFactory["create"]>> | undefined;
    return runAgentModeScope(async () => {
      instance = await new AgentFactory({
        workspace,
        globalDirectory: host.runtime.globalDirectory,
        configService,
        modelService,
        host: {
          interactionSurface: consoleView.interactionSurface,
          accessConsentBroker: consoleView.accessConsentBroker,
          processRouter: host.processRouter,
          processPlanner: host.processPlanner,
          hostRuntime: host.hostRuntime,
          reservedCommandNames: HOST_COMMAND_NAMES,
        },
      }).create(agentPackage);
      const app = instance.application;
      const skillCapability = instance.capabilities.skills;
      if (options.trace) instance.trace?.control.start();

      const registry = createCommandRegistry(app, host, instance.trace);
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
        consoleView.appendUserMessage(displayInput);
        consoleView.setStatus({ text: "thinking...", tone: "active" });
        consoleView.setActivity("Thinking…");
        const presentation = consoleView.createRunPresentation({
          skills: Boolean(skillController),
        });
        try {
          await activeRun.run((signal) => app.run(modelInput, presentation.callbacks(), signal));
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
          consoleView.setStatus({ text: "omni-agent | Ctrl+C to exit", tone: "neutral" });
        }
      }

      consoleView.bindHandlers({
        onInterrupt() {
          if (!activeRun.interrupt()) return false;
          consoleView.writeNotice("(aborted)", "warning");
          consoleView.setStatus({ text: "aborting...", tone: "neutral" });
          return true;
        },
        async onSubmit(input) {
          if (activeRun.state === "running") return;
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
      const termination = await consoleView.start();
      await activeRun.close();
      return termination;
    }, [
      { resource: "active_run", cleanup: () => activeRun.close() },
      { resource: "agent_instance", cleanup: () => instance?.dispose() },
      { resource: "console", cleanup: () => consoleView.dispose() },
    ]);
  }, [{ resource: "model_service", cleanup: () => modelService.dispose() }]);
}

interface AgentModeCleanupFailure {
  readonly resource: string;
  readonly error: unknown;
}

class AgentModeScopeError extends AggregateError {
  constructor(
    readonly operationError: unknown | undefined,
    readonly cleanupFailures: readonly AgentModeCleanupFailure[],
  ) {
    super(
      [
        ...(operationError === undefined ? [] : [operationError]),
        ...cleanupFailures.map(({ error }) => error),
      ],
      operationError === undefined
        ? "Failed to close Agent mode resources"
        : "Agent mode operation and cleanup failed",
      operationError === undefined ? undefined : { cause: operationError },
    );
    this.name = "AgentModeScopeError";
  }
}

async function runAgentModeScope<T>(
  operation: () => Promise<T>,
  resources: readonly {
    readonly resource: string;
    readonly cleanup: () => void | Promise<void> | undefined;
  }[],
): Promise<T> {
  let result: T | undefined;
  let operationError: unknown;
  let operationFailed = false;
  try {
    result = await operation();
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  const cleanupFailures: AgentModeCleanupFailure[] = [];
  for (const resource of resources) {
    try {
      await resource.cleanup();
    } catch (error) {
      cleanupFailures.push({ resource: resource.resource, error });
    }
  }

  if (cleanupFailures.length > 0) {
    throw new AgentModeScopeError(operationFailed ? operationError : undefined, cleanupFailures);
  }
  if (operationFailed) throw operationError;
  return result as T;
}
