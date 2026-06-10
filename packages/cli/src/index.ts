import chalk from "chalk";

import {
  runAgentLoop,
  loadConfig,
  getApiKey,
  createStreamSession,
  SessionManager,
  createUserMessage,
  SkillRuntime,
  type AgentConfig,
  type StreamCallbacks,
  type Message,
  type TokenUsage,
} from "@omni-agent/core";
import { createOmniTui } from "./tui";
import { bashTool, fileReadTool, fileEditTool, fileWriteTool, globTool, grepTool, webFetchTool, webSearchTool } from "./tools/index";
import { runOnboarding } from "./onboarding";
import { createCommandRegistry } from "./commands/index";
import { SkillCliController } from "./skills";

async function main() {
  // 1. Try to load existing config
  let config = loadConfig();
  let apiKey: string | null = null;

  if (config) {
    apiKey = await getApiKey(config.provider);
  }

  // 2. If config missing or key unavailable, run onboarding
  if (!config || !apiKey) {
    const result = await runOnboarding();
    config = result.config;
    apiKey = result.apiKey;
  }

  // 3. Initialize skills and build agent config
  const skillRuntime = new SkillRuntime({ cwd: process.cwd() });
  await skillRuntime.initialize();
  const buildPrompt = () => skillRuntime.buildSystemPrompt();
  const systemPrompt = await buildPrompt();
  const agentConfig: AgentConfig = {
    model: config.model,
    apiKey,
    endpoint: config.endpoint,
    provider: config.provider,
    systemPrompt,
    tools: [
      bashTool,
      fileReadTool,
      fileEditTool,
      fileWriteTool,
      globTool,
      grepTool,
      webFetchTool,
      webSearchTool,
      skillRuntime.tool(),
    ],
    toolLifecycleAdapters: skillRuntime.lifecycleAdapters(),
    maxTurns: 10,
    maxTokens: config.maxTokens,
    contextWindow: config.contextWindow,
  };

  // 4. Initialize session manager — restore latest session
  const sessionManager = new SessionManager();
  sessionManager.restoreLatest();

  const tui = createOmniTui();
  const registry = createCommandRegistry();
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
      sessionManager.create();
      ctx.tui.sink.line(chalk.green("New session started."));
      ctx.tui.sink.spacer();
    },
  });

  // Register /clear command
  registry.register({
    name: "clear",
    description: "Clear current session history",
    async execute(ctx) {
      sessionManager.clear();
      ctx.tui.sink.line(chalk.green("Session history cleared."));
      ctx.tui.sink.spacer();
    },
  });

  const skillController = new SkillCliController({
    skillRuntime,
    commandRegistry: registry,
    tui,
    agentConfig,
    buildSystemPrompt: buildPrompt,
  });
  skillController.registerCommands();

  // Provide command list to TUI for Tab completion
  skillController.refreshAutocomplete();

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
        await command.execute({ args, agentConfig, tui });
        return;
      }

      let explicitSkillPreload: Awaited<ReturnType<typeof skillController.resolveSlashPreload>> = null;
      try {
        explicitSkillPreload = await skillController.resolveSlashPreload(input);
      } catch (err) {
        tui.appendUserMessage(input);
        tui.sink.line(chalk.red(`Error reading skill: ${err instanceof Error ? err.message : String(err)}`));
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

    // Create user message via factory and append to session
    const userMsg = createUserMessage(modelInput);
    sessionManager.append(userMsg);

    // Build TUI callbacks for the stream session
    const tuiCallbacks: StreamCallbacks = {
      onTextChunk(delta) {
        tui.sink.writeMarkdown(delta);
      },
      onToolStart(toolName, _toolCallId, toolInput) {
        if (skillController.shouldSuppressToolPreview(toolName)) return;
        tui.sink.line();
        tui.sink.line(`${chalk.cyan("▶")} ${chalk.bold(toolName)} ${chalk.dim(JSON.stringify(toolInput))}`);
        tui.setStatus(chalk.cyan(`running: ${toolName}...`));
      },
      onToolEnd(_toolName, _toolCallId, result, durationMs) {
        if (skillController.shouldSuppressToolPreview(_toolName)) return;
        if (result.isError) {
          tui.sink.line(`  ${chalk.red("✗ error")} ${chalk.dim(`(${durationMs}ms)`)}`);
        } else {
          tui.sink.line(`  ${chalk.green("✓ done")} ${chalk.dim(`(${durationMs}ms)`)}`);
        }
        for (const block of result.content) {
          if (block.type === "text" && block.text) {
            const lines = block.text.split("\n").slice(0, 5);
            for (const line of lines) {
              tui.sink.line(`  ${chalk.dim(line)}`);
            }
            const total = block.text.split("\n").length;
            if (total > 5) {
              tui.sink.line(`  ${chalk.dim(`... ${total - 5} more lines`)}`);
            }
          }
        }
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
      ...skillController.streamCallbacks(),
    };

    const streamSession = createStreamSession(tuiCallbacks);

    try {
      // Pass full conversation history to the agent loop
      const events = runAgentLoop(
        agentConfig,
        [...sessionManager.messages] as Message[],
        activeAbort.signal,
        { session: streamSession },
      );

      // Consume the generator to drive the loop
      for await (const event of events) {
        // On done, persist produced messages to session
        if (event.type === "done" && event.produced) {
          sessionManager.appendBatch(event.produced);
        }
      }
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
  tui.sink.line(chalk.bold("omni-agent"));
  tui.sink.line(chalk.dim("Type your request below. Session history is preserved across restarts."));
  tui.sink.spacer();

  await tui.start();
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
