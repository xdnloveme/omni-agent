import type { AgentConfig } from "../types";

/**
 * Minimal TUI interface that commands can use.
 * The full OmniTui in cli satisfies this contract.
 */
export interface CommandTui {
  pause(): void;
  resume(): void;
  sink: {
    line(text?: string): void;
    spacer(): void;
  };
}

export interface CommandContext {
  args: string;
  agentConfig: AgentConfig;
  tui: CommandTui;
}

export interface Command {
  name: string;
  description: string;
  execute(ctx: CommandContext): Promise<void>;
}
