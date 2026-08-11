import type { AgentConfig } from "../types";

/**
 * Minimal TUI interface that commands can use.
 * The full OmniTui in cli satisfies this contract.
 */
export interface CommandTui {
  pause(): void;
  resume(): void;
  select?(options: CommandSelectionOptions, signal?: AbortSignal): Promise<CommandSelectionResult>;
  sink: {
    line(text?: string): void;
    spacer(): void;
  };
}

export interface CommandSelectionOptions {
  title: string;
  detail?: string;
  message?: string;
  tone?: "default" | "warning" | "danger";
  items: Array<{
    value: string;
    label: string;
    description?: string;
    tone?: "default" | "positive" | "negative";
  }>;
}

export type CommandSelectionResult =
  | { kind: "selected"; value: string }
  | { kind: "escape" }
  | { kind: "abort"; error: Error }
  | { kind: "shutdown"; error: Error };

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
