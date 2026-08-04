import chalk from "chalk";

import type { Command } from "@omni-agent/core";
import { runOnboarding } from "../onboarding";

export const configCommand: Command = {
  name: "config",
  description: "Reconfigure LLM provider and API key",
  async execute(ctx) {
    ctx.tui.pause();
    let updated = false;
    try {
      const result = await runOnboarding();
      ctx.agentConfig.provider = result.config.provider;
      ctx.agentConfig.endpoint = result.config.endpoint;
      ctx.agentConfig.model = result.config.model;
      ctx.agentConfig.apiKey = result.apiKey;
      ctx.agentConfig.maxTokens = result.config.maxTokens;
      ctx.agentConfig.contextWindow = result.config.contextWindow;
      updated = true;
    } catch (err) {
      console.error(
        chalk.red(`Configuration failed: ${err instanceof Error ? err.message : String(err)}`),
      );
    }
    ctx.tui.resume();
    if (updated) {
      ctx.tui.sink.line(chalk.green(`Configuration updated. Using ${ctx.agentConfig.provider} now.`));
    }
    ctx.tui.sink.spacer();
  },
};
