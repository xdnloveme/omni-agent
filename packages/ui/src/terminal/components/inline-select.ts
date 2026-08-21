import {
  Key,
  hyperlink,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import chalk from "chalk";
import type { CommandSelectionOptions } from "@omni-agent/core";

const MAX_VISIBLE_OPTIONS = 8;

function wrapField(text: string, width: number, style: (value: string) => string): string[] {
  return text.split("\n").flatMap((line) => wrapTextWithAnsi(style(line), Math.max(10, width - 2)));
}

function fillLine(text: string, width: number, style: (value: string) => string): string {
  const clipped = truncateToWidth(text, width, "");
  return style(`${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`);
}

/** A selection card that lives in conversation history instead of an overlay. */
export class InlineSelect implements Component, Focusable {
  focused = false;
  private selectedIndex = 0;
  private optionRows = new Map<number, number>();
  private resolvedLabel: string | null = null;
  private cancelled = false;
  onSelect?: (value: string) => void;
  onCancel?: () => void;

  constructor(
    private readonly options: CommandSelectionOptions,
    private readonly linkForValue?: (value: string) => string,
  ) {}

  handleInput(data: string): void {
    if (this.isResolved() || this.options.items.length === 0) return;
    if (matchesKey(data, Key.up)) {
      this.selectedIndex =
        this.selectedIndex === 0 ? this.options.items.length - 1 : this.selectedIndex - 1;
    } else if (matchesKey(data, Key.down)) {
      this.selectedIndex =
        this.selectedIndex === this.options.items.length - 1 ? 0 : this.selectedIndex + 1;
    } else if (matchesKey(data, Key.enter)) {
      this.select(this.selectedIndex);
    } else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.onCancel?.();
    }
  }

  handleClick(row: number): void {
    const index = this.optionRows.get(row);
    if (index === undefined || this.isResolved()) return;
    this.selectedIndex = index;
    this.select(index);
  }

  resolve(value?: string): void {
    const item = value
      ? this.options.items.find((candidate) => candidate.value === value)
      : undefined;
    this.resolvedLabel = item?.label ?? value ?? null;
    this.cancelled = !value;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(20, width);
    const tone = this.options.tone ?? "default";
    const accent = tone === "danger" ? chalk.red : tone === "warning" ? chalk.yellow : chalk.cyan;
    if (this.isResolved()) {
      const resolvedItem = this.options.items.find((item) => item.label === this.resolvedLabel);
      const state = this.cancelled
        ? chalk.yellow("cancelled")
        : resolvedItem?.tone === "negative"
          ? chalk.red(this.resolvedLabel!)
          : chalk.green(this.resolvedLabel!);
      return [
        truncateToWidth(`${accent("◆")} ${chalk.bold(this.options.title)}  ${state}`, safeWidth),
      ];
    }

    const lines: string[] = [];
    if (tone !== "default") {
      const label = tone === "danger" ? "⛔ HIGH-RISK PERMISSION REQUIRED" : "⚠ ACTION REQUIRED";
      const bannerStyle = tone === "danger" ? chalk.bold.white.bgRed : chalk.bold.black.bgYellow;
      lines.push(fillLine(` ${label} `, safeWidth, bannerStyle));
    }
    lines.push(`${accent("┏━")} ${chalk.bold(this.options.title)}`);
    if (this.options.detail) {
      lines.push(
        ...wrapField(
          this.options.detail,
          safeWidth,
          tone === "default" ? chalk.dim : chalk.bold,
        ).map((line) => `${accent("┃")} ${line}`),
      );
    }
    if (this.options.message) {
      lines.push(
        ...wrapField(this.options.message, safeWidth, (value) => value).map(
          (line) => `${accent("┃")} ${tone === "default" ? line : accent(line)}`,
        ),
      );
    }
    lines.push(accent("┣━━━━━━━━"));
    this.optionRows = new Map();

    const startIndex = Math.max(
      0,
      Math.min(
        this.selectedIndex - Math.floor(MAX_VISIBLE_OPTIONS / 2),
        this.options.items.length - MAX_VISIBLE_OPTIONS,
      ),
    );
    const endIndex = Math.min(startIndex + MAX_VISIBLE_OPTIONS, this.options.items.length);
    const visibleItems = this.options.items.slice(startIndex, endIndex);

    visibleItems.forEach((item, visibleIndex) => {
      const index = startIndex + visibleIndex;
      const selected = index === this.selectedIndex;
      const marker = selected ? accent("▶") : " ";
      const itemStyle =
        item.tone === "positive"
          ? chalk.green
          : item.tone === "negative"
            ? chalk.red
            : (value: string) => value;
      const description = item.description
        ? `  ${chalk.dim(item.description.replace(/[\r\n]+/g, " "))}`
        : "";
      this.optionRows.set(lines.length, index);
      const optionContent = `${marker} ${selected ? chalk.bold(itemStyle(`[ ${item.label} ]`)) : itemStyle(`  ${item.label}  `)}${description}`;
      lines.push(
        truncateToWidth(
          `${accent("┃")} ${
            this.linkForValue
              ? hyperlink(optionContent, this.linkForValue(item.value))
              : optionContent
          }`,
          safeWidth,
        ),
      );
    });

    if (this.options.items.length === 0) {
      lines.push(`${accent("┃")} ${chalk.dim("(no options)")}`);
    } else if (startIndex > 0 || endIndex < this.options.items.length) {
      lines.push(
        `${accent("┃")} ${chalk.dim(`${this.selectedIndex + 1}/${this.options.items.length}`)}`,
      );
    }

    const dismissLabel = this.options.dismissLabel ?? "cancel";
    const hint = this.focused
      ? `click or ↑/↓ to select · Enter to confirm · Esc to ${dismissLabel}`
      : "click to select";
    lines.push(`${accent("┗━")} ${chalk.dim(hint)}`);
    return lines.map((line) =>
      visibleWidth(line) <= safeWidth ? line : truncateToWidth(line, safeWidth, ""),
    );
  }

  private select(index: number): void {
    const item = this.options.items[index];
    if (item) this.onSelect?.(item.value);
  }

  private isResolved(): boolean {
    return this.resolvedLabel !== null || this.cancelled;
  }
}
