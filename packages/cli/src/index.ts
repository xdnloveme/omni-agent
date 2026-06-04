import chalk from "chalk";

import { runAgentLoop, loadConfig, getApiKey, type AgentConfig } from "@omni-agent/core";
import { createOmniTui } from "./tui.js";
import { bashTool } from "./tools/bash.js";
import { SYSTEM_PROMPT } from "./system-prompt.js";
import { runOnboarding } from "./onboarding.js";
import { createCommandRegistry } from "./commands/index.js";

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

  // 3. Build agent config
  const agentConfig: AgentConfig = {
    model: config.model,
    apiKey,
    endpoint: config.endpoint,
    provider: config.provider,
    systemPrompt: SYSTEM_PROMPT,
    tools: [bashTool],
    maxTurns: 10,
  };

  const tui = createOmniTui();
  const registry = createCommandRegistry();
  let activeAbort: AbortController | null = null;
  let running = false;

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
      const command = registry.get(cmdName);
      if (command) {
        tui.appendUserMessage(input);
        await command.execute({ args, agentConfig, tui });
        return;
      }
      tui.appendUserMessage(input);
      tui.sink.line(chalk.yellow("Unknown command. Type /help for available commands."));
      tui.sink.spacer();
      return;
    }

    running = true;
    activeAbort = new AbortController();
    tui.appendUserMessage(input);
    tui.setStatus(chalk.cyan("thinking..."));

    try {
      const events = runAgentLoop(agentConfig, input, activeAbort.signal);

      for await (const event of events) {
        switch (event.type) {
          case "text_delta":
            tui.sink.writeMarkdown(event.delta);
            break;

          case "tool_start":
            tui.sink.line();
            tui.sink.line(`${chalk.cyan("▶")} ${chalk.bold(event.toolName)} ${chalk.dim(JSON.stringify(event.input))}`);
            tui.setStatus(chalk.cyan(`running: ${event.toolName}...`));
            break;

          case "tool_end":
            if (event.result.isError) {
              tui.sink.line(`  ${chalk.red("✗ error")} ${chalk.dim(`(${event.durationMs}ms)`)}`);
            } else {
              tui.sink.line(`  ${chalk.green("✓ done")} ${chalk.dim(`(${event.durationMs}ms)`)}`);
            }
            for (const block of event.result.content) {
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
            break;

          case "error":
            tui.sink.line();
            tui.sink.line(chalk.red(`Error: ${event.error}`));
            tui.sink.spacer();
            break;

          case "done":
            tui.sink.line();
            tui.sink.spacer();
            break;
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
  };

  // Welcome message
  tui.sink.line(chalk.bold("omni-agent"));
  tui.sink.line(chalk.dim(`Provider: ${config.provider} | Model: ${config.model}`));
  tui.sink.line(chalk.dim("Type your request below."));
  tui.sink.spacer();

  await tui.start();
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
