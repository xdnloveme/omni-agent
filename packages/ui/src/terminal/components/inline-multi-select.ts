import {
  Key,
  matchesKey,
  truncateToWidth,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import chalk from "chalk";

export interface MultiSelectOptions {
  readonly title: string;
  readonly detail?: string;
  readonly message?: string;
  readonly tone?: "default" | "warning" | "danger";
  readonly dismissLabel?: string;
  readonly items: readonly {
    readonly value: string;
    readonly label: string;
    readonly description?: string;
    readonly tone?: "default" | "positive" | "negative";
  }[];
}

export class InlineMultiSelect implements Component, Focusable {
  focused = false;
  onSubmit?: (values: readonly string[]) => void;
  onCancel?: () => void;
  private selectedIndex = 0;
  private readonly selected = new Set<string>();
  private resolved = false;
  private optionRows = new Map<number, number>();

  constructor(private readonly options: MultiSelectOptions) {}

  handleInput(data: string): void {
    if (this.resolved || this.options.items.length === 0) return;
    if (matchesKey(data, Key.up)) {
      this.selectedIndex =
        this.selectedIndex === 0 ? this.options.items.length - 1 : this.selectedIndex - 1;
    } else if (matchesKey(data, Key.down)) {
      this.selectedIndex =
        this.selectedIndex === this.options.items.length - 1 ? 0 : this.selectedIndex + 1;
    } else if (matchesKey(data, Key.space)) {
      this.toggle(this.selectedIndex);
    } else if (matchesKey(data, Key.enter)) {
      this.onSubmit?.([...this.selected]);
    } else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.onCancel?.();
    }
  }

  handleClick(row: number): void {
    if (this.resolved) return;
    const index = this.optionRows.get(row);
    if (index === undefined) return;
    this.selectedIndex = index;
    this.toggle(index);
  }

  complete(values?: readonly string[]): void {
    this.resolved = true;
    this.selected.clear();
    for (const value of values ?? []) this.selected.add(value);
  }

  invalidate(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(20, width);
    const tone = this.options.tone ?? "default";
    const accent = tone === "danger" ? chalk.red : tone === "warning" ? chalk.yellow : chalk.cyan;
    if (this.resolved) {
      const labels = this.options.items
        .filter((item) => this.selected.has(item.value))
        .map((item) => item.label);
      return [
        truncateToWidth(
          `${accent("◆")} ${chalk.bold(this.options.title)}  ${labels.length ? chalk.green(labels.join(", ")) : chalk.yellow("none")}`,
          safeWidth,
        ),
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
    if (this.options.detail) lines.push(`${accent("┃")} ${chalk.dim(this.options.detail)}`);
    if (this.options.message) lines.push(`${accent("┃")} ${this.options.message}`);
    lines.push(accent("┣━━━━━━━━"));
    this.optionRows = new Map();
    for (const [index, item] of this.options.items.entries()) {
      const cursor = index === this.selectedIndex ? chalk.cyan("▶") : " ";
      const mark = this.selected.has(item.value) ? chalk.green("[x]") : "[ ]";
      const itemStyle =
        item.tone === "positive"
          ? chalk.green
          : item.tone === "negative"
            ? chalk.red
            : (value: string) => value;
      this.optionRows.set(lines.length, index);
      lines.push(
        truncateToWidth(
          `${accent("┃")} ${cursor} ${mark} ${itemStyle(item.label)}${item.description ? `  ${chalk.dim(item.description)}` : ""}`,
          safeWidth,
        ),
      );
    }
    const dismissLabel = this.options.dismissLabel ?? "cancel";
    lines.push(
      `${accent("┗━")} ${chalk.dim(`↑/↓ move · Space toggle · Enter confirm · Esc to ${dismissLabel}`)}`,
    );
    return lines;
  }

  private toggle(index: number): void {
    const value = this.options.items[index]?.value;
    if (!value) return;
    if (this.selected.has(value)) this.selected.delete(value);
    else this.selected.add(value);
  }
}
