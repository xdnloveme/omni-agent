import {
  Box,
  SelectList,
  Spacer,
  Text,
  type Component,
  type SelectListTheme,
} from "@mariozechner/pi-tui";
import chalk from "chalk";
import type { CommandSelectionOptions } from "@omni-agent/core";

export type ModalSelectOptions = CommandSelectionOptions;

export class ModalSelect implements Component {
  private readonly box = new Box(1, 1, (text) => chalk.bgAnsi256(236)(text));
  private readonly list: SelectList;
  onSelect?: (value: string) => void;
  onCancel?: () => void;

  constructor(options: ModalSelectOptions, theme: SelectListTheme) {
    this.list = new SelectList(options.items, Math.min(8, options.items.length), theme);
    this.box.addChild(new Text(chalk.bold(options.title), 0, 0));
    if (options.detail) this.box.addChild(new Text(chalk.dim(options.detail), 0, 0));
    if (options.message) this.box.addChild(new Text(options.message, 0, 0));
    this.box.addChild(new Spacer(1));
    this.box.addChild(this.list);
    this.box.addChild(new Spacer(1));
    this.box.addChild(new Text(chalk.dim("↑/↓ select · Enter confirm · Esc cancel"), 0, 0));
    this.list.onSelect = (item) => this.onSelect?.(item.value);
    this.list.onCancel = () => this.onCancel?.();
  }

  handleInput(data: string): void {
    this.list.handleInput(data);
  }

  render(width: number): string[] {
    return this.box.render(width);
  }

  invalidate(): void {
    this.box.invalidate();
  }
}
