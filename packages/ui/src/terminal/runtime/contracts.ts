import type { CommandSelectionOptions, CommandSelectionResult } from "@omni-agent/core";
import type { MultiSelectOptions } from "../components/inline-multi-select";
import type { InlineTextInputOptions } from "../components/inline-text-input";
import type {
  RunPresentationViewModel,
  SessionHistoryViewModel,
} from "../presentation/view-models";

export interface TuiSink {
  renderRun(viewModel: RunPresentationViewModel): void;
  write(text: string): void;
  line(text?: string): void;
  spacer(): void;
}

export interface SlashCommand {
  name: string;
  description: string;
}

export type TuiTermination =
  | { readonly kind: "completed" }
  | { readonly kind: "user_interrupt" }
  | { readonly kind: "signal"; readonly signal: "SIGTERM" };

export interface OmniTui {
  start(): Promise<TuiTermination>;
  sink: TuiSink;
  appendUserMessage(text: string): void;
  setSessionHistory(
    viewModel: SessionHistoryViewModel,
    onLoadEarlier?: () => void | Promise<void>,
  ): void;
  clearSessionHistory(): void;
  setStatus(text: string): void;
  startActivity(text: string): void;
  setActivity(text: string): void;
  stopActivity(): void;
  setCommands(commands: SlashCommand[]): void;
  onSubmit: (input: string) => void | Promise<void>;
  onInterrupt: (() => boolean) | null;
  select(options: CommandSelectionOptions, signal?: AbortSignal): Promise<CommandSelectionResult>;
  multiSelect(options: MultiSelectOptions, signal?: AbortSignal): Promise<TuiMultiSelectResult>;
  textInput(options: TuiTextInputOptions, signal?: AbortSignal): Promise<TuiTextInputResult>;
  pause(): void;
  resume(): void;
  shutdown(termination?: TuiTermination): void;
}

export type TuiMultiSelectResult =
  | { readonly kind: "selected"; readonly values: readonly string[] }
  | { readonly kind: "escape" }
  | { readonly kind: "abort"; readonly error: Error }
  | { readonly kind: "shutdown"; readonly error: Error };

export type TuiTextInputOptions = InlineTextInputOptions;

export type TuiTextInputResult =
  | { readonly kind: "submitted"; readonly text: string }
  | { readonly kind: "escape" }
  | { readonly kind: "abort"; readonly error: Error }
  | { readonly kind: "shutdown"; readonly error: Error };

export interface TuiOptions {
  readonly workspaceRoot: string;
}
