import chalk from "chalk";

import { formatSanitizedToolInput, type StreamCallbacks, type TokenUsage } from "@omni-agent/core";
import { AgentFactory, ConfigService, createModelService } from "@omni-agent/app";
import { loadAgentBlueprint } from "../agents/agent-blueprint-loader";
import { createOmniTui } from "../interaction/tui/tui";
import { persistOnboardingSelection, runOnboarding } from "../onboarding";
import { createCommandRegistry } from "../commands/index";
import { SkillCliController } from "../skills";
import { TuiApprovalBroker } from "../permissions/tui-approval-broker";

export async function runChatMode(agentId: string): Promise<void> {
  const configService = new ConfigService();
  const resolvedConfiguration = await configService.resolveModelConfiguration(agentId);
  const selection = resolvedConfiguration?.selection ?? null;
  for (const diagnostic of configService.diagnostics) {
    console.warn(chalk.yellow(`Configuration ${diagnostic.code}: ${diagnostic.message}`));
  }
  const modelService = await createModelService({ cwd: process.cwd() });
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

    const tui = createOmniTui();
    const blueprint = await loadAgentBlueprint(agentId);
    const instance = await new AgentFactory({
      cwd: process.cwd(),
      configService,
      modelService,
      approvalBroker: new TuiApprovalBroker(tui),
    }).create(blueprint);
    const app = instance.application;
    const agentConfig = app.agentConfig;
    const skillCapability = instance.capabilities.skills;

    const registry = createCommandRegistry(app);
    let activeAbort: AbortController | null = null;
    let running = false;

    /** Format context usage line with color */
    function formatContextLine(usage: TokenUsage): string {
      const pct = Math.round((usage.inputTokens / usage.contextWindow) * 100);
      const inputStr = `${usage.estimated ? "~" : ""}${usage.inputTokens.toLocaleString()}`;
      const windowStr = usage.contextWindow.toLocaleString();
      const text = `Context: ${inputStr} / ${windowStr} tokens (${pct}%)`;

      if (pct > 80) {
        return chalk.red(text);
      } else if (pct >= 50) {
        return chalk.yellow(text);
      } else {
        return chalk.dim(text);
      }
    }

    // Register /new command
    registry.register({
      name: "new",
      description: "Start a new conversation session",
      async execute(ctx) {
        await app.newSession();
        ctx.tui.sink.line(chalk.green("New session started."));
        ctx.tui.sink.spacer();
      },
    });

    // Register /clear command
    registry.register({
      name: "clear",
      description: "Clear current session history",
      async execute(ctx) {
        await app.clearSession();
        ctx.tui.sink.line(chalk.green("Session history cleared."));
        ctx.tui.sink.spacer();
      },
    });

    const skillController = skillCapability
      ? new SkillCliController({
          skillRuntime: skillCapability.runtime,
          commandRegistry: registry,
          tui,
          agentConfig,
          buildSystemPrompt: skillCapability.buildSystemPrompt,
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
      running = false;
      activeAbort = null;
      tui.setStatus(chalk.dim("omni-agent | Ctrl+C to exit"));
      return true;
    };

    tui.onSubmit = async (input: string) => {
      if (running) return;

      // Handle slash commands
      if (input.startsWith("/")) {
        const parts = input.slice(1).split(/\s+/);
        const cmdName = parts[0].toLowerCase();
        const args = input.slice(1 + cmdName.length).trim();
        // Bare "/" with no command name → show help
        const command = registry.get(cmdName || "help");
        if (command) {
          tui.appendUserMessage(input);
          try {
            await command.execute({ args, agentConfig, tui });
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

        if (!skillController) {
          tui.appendUserMessage(input);
          tui.sink.line(chalk.yellow("Unknown command. Type /help for available commands."));
          tui.sink.spacer();
          return;
        }

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

        if (!explicitSkillPreload) {
          tui.appendUserMessage(input);
          tui.sink.line(chalk.yellow("Unknown command. Type /help for available commands."));
          tui.sink.spacer();
          return;
        }

        await runUserInput(input, explicitSkillPreload.modelInput);
        return;
      }

      await runUserInput(input, input);
    };

    async function runUserInput(displayInput: string, modelInput: string) {
      running = true;
      activeAbort = new AbortController();
      tui.appendUserMessage(displayInput);
      tui.setStatus(chalk.cyan("thinking..."));

      // Build TUI callbacks for the application event stream
      const tuiCallbacks: StreamCallbacks = {
        onTextChunk(delta) {
          tui.sink.writeMarkdown(delta);
        },
        onToolStart(toolName, toolCallId, toolInput) {
          if (skillController?.shouldSuppressToolPreview(toolName)) return;
          tui.sink.toolStart(toolName, toolCallId, formatSanitizedToolInput(toolInput));
          tui.setStatus(chalk.cyan(`running: ${toolName}...`));
        },
        onToolEnd(toolName, toolCallId, result, durationMs) {
          if (skillController?.shouldSuppressToolPreview(toolName)) return;
          tui.sink.toolEnd(toolCallId, result, durationMs);
          tui.sink.spacer();
          tui.setStatus(chalk.cyan("thinking..."));
        },
        onDone(usage) {
          tui.sink.line();
          if (usage) {
            tui.sink.line(formatContextLine(usage));
          }
          tui.sink.spacer();
        },
        onError(error) {
          tui.sink.line();
          tui.sink.line(chalk.red(`Error: ${error}`));
          tui.sink.spacer();
        },
        ...skillController?.streamCallbacks(),
      };

      try {
        await app.run(modelInput, tuiCallbacks, activeAbort.signal);
      } catch (err) {
        if (!(err instanceof Error && err.name === "AbortError")) {
          tui.sink.line(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
          tui.sink.spacer();
        }
      } finally {
        running = false;
        activeAbort = null;
        tui.setStatus(chalk.dim("omni-agent | Ctrl+C to exit"));
      }
    }

    // Welcome message
    tui.sink.line(chalk.bold(`omni-agent · ${instance.id}`));
    tui.sink.line(
      chalk.dim("Type your request below. Session history is preserved across restarts."),
    );
    tui.sink.spacer();

    try {
      await tui.start();
    } finally {
      await instance.dispose();
    }
  } finally {
    await modelService.dispose();
  }
}
