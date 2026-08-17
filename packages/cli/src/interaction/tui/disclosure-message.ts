import {
  hyperlink,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import chalk from "chalk";
import type { DisclosureViewModel } from "../../presentation/view-models";

export class DisclosureMessage implements Component {
  private expanded: boolean;
  private cachedDetails: readonly string[] | undefined;
  private readonly children = new Map<string, DisclosureMessage>();

  constructor(
    private viewModel: DisclosureViewModel,
    private readonly linkUrl: string,
    private readonly now: () => number = Date.now,
  ) {
    this.expanded = viewModel.initiallyExpanded;
    this.syncChildren(viewModel.children ?? []);
  }

  update(viewModel: DisclosureViewModel): void {
    if (this.viewModel === viewModel) return;
    const completed = this.viewModel.state === "running" && viewModel.state === "completed";
    this.viewModel = viewModel;
    this.cachedDetails = undefined;
    if (completed && viewModel.collapseOnComplete) this.expanded = false;
    else if (viewModel.initiallyExpanded) this.expanded = true;
    this.syncChildren(viewModel.children ?? []);
  }

  toggle(targetId: string = this.viewModel.id): boolean {
    if (targetId !== this.viewModel.id) {
      for (const child of this.children.values()) {
        if (child.toggle(targetId)) return true;
      }
      return false;
    }
    this.expanded = !this.expanded;
    if (this.expanded && !this.cachedDetails) this.cachedDetails = this.viewModel.details();
    return true;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(20, width);
    const marker = this.expanded ? "▼" : "▶";
    const state = renderState(this.viewModel, this.now());
    const summary = this.viewModel.summary
      ? renderResponsiveSummary(this.viewModel.summary, safeWidth, this.viewModel.title, state)
      : "";
    const header = truncateToWidth(
      `${marker} ${chalk.bold(this.viewModel.title)}${summary ? `  ${chalk.dim(summary)}` : ""}  ${state}`,
      safeWidth,
    );
    const lines = [hyperlink(header, this.linkUrl)];
    if (!this.expanded) return lines;
    this.cachedDetails ??= this.viewModel.details();
    for (const detail of this.cachedDetails) {
      lines.push(...indentWrapped(chalk.dim(detail), safeWidth, chalk.dim("│ ")));
    }
    for (const child of this.children.values()) {
      for (const line of child.render(Math.max(20, safeWidth - 2))) {
        lines.push(`│ ${line}`);
      }
    }
    lines.push(chalk.dim("└─ click to collapse"));
    return lines;
  }

  private syncChildren(viewModels: readonly DisclosureViewModel[]): void {
    const retained = new Set(viewModels.map((viewModel) => viewModel.id));
    for (const id of this.children.keys()) {
      if (!retained.has(id)) this.children.delete(id);
    }
    for (const viewModel of viewModels) {
      const child = this.children.get(viewModel.id);
      if (child) child.update(viewModel);
      else {
        this.children.set(
          viewModel.id,
          new DisclosureMessage(viewModel, disclosureUrl(viewModel.id), this.now),
        );
      }
    }
  }
}

function renderState(viewModel: DisclosureViewModel, now: number): string {
  switch (viewModel.state) {
    case "waiting":
      return chalk.dim("waiting");
    case "running": {
      const elapsed =
        viewModel.startedAt === undefined ? 0 : Math.max(0, now - viewModel.startedAt);
      const suffix = elapsed < 1_000 ? "" : ` ${formatElapsed(elapsed)}`;
      return chalk.cyan(`running…${suffix}`);
    }
    case "completed":
      return viewModel.tone === "warning" ? chalk.yellow("⚠ done") : chalk.green("✓ done");
    case "failed":
      return chalk.red("✗ error");
    case "cancelled":
      return chalk.yellow("cancelled");
  }
}

export function disclosureUrl(id: string): string {
  return `omni-agent://disclosure/${encodeURIComponent(id)}`;
}

function formatElapsed(durationMs: number): string {
  const totalSeconds = Math.floor(durationMs / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function renderResponsiveSummary(
  summary: string,
  width: number,
  title: string,
  state: string,
): string {
  const available = Math.max(8, width - visibleWidth(title) - visibleWidth(state) - 8);
  return middleEllipsis(summary, available);
}

function middleEllipsis(value: string, width: number): string {
  if (visibleWidth(value) <= width) return value;
  if (width <= 4) return truncateToWidth(value, width, "…");
  const tailWidth = Math.max(3, Math.ceil((width - 1) * 0.65));
  const headWidth = width - tailWidth - 1;
  return `${truncateToWidth(value, headWidth, "")}…${takeEndToWidth(value, tailWidth)}`;
}

function takeEndToWidth(value: string, width: number): string {
  const characters = Array.from(value);
  const selected: string[] = [];
  let used = 0;
  for (let index = characters.length - 1; index >= 0; index--) {
    const character = characters[index];
    const characterWidth = visibleWidth(character);
    if (used + characterWidth > width) break;
    selected.unshift(character);
    used += characterWidth;
  }
  return selected.join("");
}

function indentWrapped(text: string, width: number, prefix: string): string[] {
  const contentWidth = Math.max(10, width - visibleWidth(prefix));
  const lines: string[] = [];
  for (const sourceLine of text.split("\n")) {
    const wrapped = wrapTextWithAnsi(sourceLine, contentWidth);
    lines.push(...(wrapped.length ? wrapped.map((line) => `${prefix}${line}`) : [prefix]));
  }
  return lines;
}
