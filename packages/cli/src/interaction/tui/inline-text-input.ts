import {
  Input,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import chalk from "chalk";

export interface InlineTextInputOptions {
  readonly title: string;
  readonly detail?: string;
  readonly message?: string;
  readonly tone?: "default" | "warning" | "danger";
  readonly placeholder?: string;
  readonly dismissLabel?: string;
  readonly acceptsEmpty?: boolean;
}

/** A single-line input card that keeps interaction text out of the conversation editor. */
export class InlineTextInput implements Component, Focusable {
  onSubmit?: (text: string) => void;
  onCancel?: () => void;
  private readonly input = new Input();
  private resolved = false;
  private resolvedText: string | undefined;

  constructor(private readonly options: InlineTextInputOptions) {
    this.input.onSubmit = (value) => {
      const text = value.trim();
      if (!text && !this.options.acceptsEmpty) return;
      this.onSubmit?.(text);
    };
    this.input.onEscape = () => this.onCancel?.();
  }

  get focused(): boolean {
    return this.input.focused;
  }

  set focused(value: boolean) {
    this.input.focused = value;
  }

  handleInput(data: string): void {
    if (!this.resolved) this.input.handleInput(data);
  }

  complete(text?: string): void {
    this.resolved = true;
    this.resolvedText = text;
  }

  invalidate(): void {
    this.input.invalidate();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(20, width);
    const tone = this.options.tone ?? "default";
    const accent = tone === "danger" ? chalk.red : tone === "warning" ? chalk.yellow : chalk.cyan;
    if (this.resolved) {
      const state =
        this.resolvedText === undefined
          ? chalk.yellow("cancelled")
          : chalk.green(this.resolvedText || "(empty)");
      return [
        truncateToWidth(`${accent("◆")} ${chalk.bold(this.options.title)}  ${state}`, safeWidth),
      ];
    }

    const lines: string[] = [];
    if (tone !== "default") {
      lines.push(
        tone === "danger"
          ? chalk.bold.white.bgRed(" ⛔ HIGH-RISK ACTION REQUIRED ")
          : chalk.bold.black.bgYellow(" ⚠ ACTION REQUIRED "),
      );
    }
    lines.push(`${accent("┏━")} ${chalk.bold(this.options.title)}`);
    if (this.options.detail) {
      lines.push(
        ...this.wrapField(this.options.detail, safeWidth).map((line) => `${accent("┃")} ${line}`),
      );
    }
    if (this.options.message) {
      lines.push(
        ...this.wrapField(this.options.message, safeWidth, false).map(
          (line) => `${accent("┃")} ${line}`,
        ),
      );
    }
    lines.push(accent("┣━━━━━━━━"));
    lines.push(`${accent("┃")} ${this.input.render(Math.max(1, safeWidth - 2))[0] ?? ""}`);
    if (this.options.placeholder) {
      lines.push(`${accent("┃")} ${chalk.dim(`Hint: ${this.options.placeholder}`)}`);
    }
    lines.push(
      `${accent("┗━")} ${chalk.dim(`Enter to submit · Esc to ${this.options.dismissLabel ?? "cancel"}`)}`,
    );
    return lines.map((line) =>
      visibleWidth(line) <= safeWidth ? line : truncateToWidth(line, safeWidth, ""),
    );
  }

  private wrapField(text: string, width: number, dim = true): string[] {
    return text
      .split("\n")
      .flatMap((line) => wrapTextWithAnsi(dim ? chalk.dim(line) : line, Math.max(10, width - 2)));
  }
}
