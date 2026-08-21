import { hyperlink, Text, type Component, type MarkdownTheme } from "@earendil-works/pi-tui";
import chalk from "chalk";
import type {
  RunMetricsViewModel,
  RunPresentationNode,
  RunPresentationViewModel,
} from "../presentation/view-models";
import { formatElapsedTime } from "../presentation/format";
import { DisclosureMessage, disclosureUrl } from "./disclosure-message";
import { MarkdownMessage } from "./markdown-message";

export class RunMessage implements Component {
  private viewModel: RunPresentationViewModel;
  private processExpanded = true;
  private autoCollapsed = false;
  private readonly markdown = new Map<string, MarkdownMessage>();
  private readonly disclosures = new Map<string, DisclosureMessage>();

  constructor(
    viewModel: RunPresentationViewModel,
    private readonly markdownTheme: MarkdownTheme,
    private readonly linkUrl: string,
    private readonly now: () => number = Date.now,
  ) {
    this.viewModel = viewModel;
    if (viewModel.finalNode) {
      this.processExpanded = false;
      this.autoCollapsed = true;
    }
    this.sync(viewModel);
  }

  update(viewModel: RunPresentationViewModel): void {
    const firstFinalProjection = !this.autoCollapsed && viewModel.finalNode !== undefined;
    this.viewModel = viewModel;
    if (firstFinalProjection) {
      this.processExpanded = false;
      this.autoCollapsed = true;
    }
    this.sync(viewModel);
  }

  toggle(targetId: string): boolean {
    if (targetId === this.viewModel.id) {
      this.processExpanded = !this.processExpanded;
      return true;
    }
    for (const disclosure of this.disclosures.values()) {
      if (disclosure.toggle(targetId)) return true;
    }
    return false;
  }

  invalidate(): void {
    for (const markdown of this.markdown.values()) markdown.invalidate();
    for (const disclosure of this.disclosures.values()) disclosure.invalidate();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(20, width);
    const lines = [this.renderHeader()];
    if (this.processExpanded) {
      for (const node of this.viewModel.processNodes) {
        lines.push(...this.renderNode(node, safeWidth));
      }
    }
    if (this.viewModel.finalNode) {
      lines.push(chalk.dim("─".repeat(safeWidth)));
      lines.push(...this.componentForText(this.viewModel.finalNode).render(safeWidth));
    }
    if (this.viewModel.metrics) {
      lines.push("");
      lines.push(this.renderMetrics(this.viewModel.metrics, safeWidth));
    }
    return lines;
  }

  private renderHeader(): string {
    const marker = this.processExpanded ? "▼" : "▶";
    const duration = formatElapsedTime(
      Math.max(0, (this.viewModel.completedAt ?? this.now()) - this.viewModel.startedAt),
    );
    const label =
      this.viewModel.state === "running" && !this.viewModel.finalNode
        ? `Working… ${duration}`
        : `Worked for ${duration}`;
    return hyperlink(chalk.dim(`${label} ${marker}`), this.linkUrl);
  }

  private renderNode(node: RunPresentationNode, width: number): string[] {
    switch (node.kind) {
      case "text":
        return this.componentForText(node).render(width);
      case "disclosure":
        return this.disclosures.get(node.id)?.render(width) ?? [];
      case "plain":
        return new Text(node.text, 0, 0).render(width);
      case "spacer":
        return [""];
    }
  }

  private componentForText(node: Extract<RunPresentationNode, { kind: "text" }>): MarkdownMessage {
    const component = this.markdown.get(node.id);
    if (!component) throw new Error(`Missing Markdown component for ${node.id}`);
    return component;
  }

  private renderMetrics(metrics: RunMetricsViewModel, width: number): string {
    const text = width >= 90 ? metrics.full : width >= 55 ? metrics.compact : metrics.minimal;
    return metrics.usagePercent > 80
      ? chalk.red(text)
      : metrics.usagePercent >= 50
        ? chalk.yellow(text)
        : chalk.dim(text);
  }

  private sync(viewModel: RunPresentationViewModel): void {
    const nodes = viewModel.finalNode
      ? [...viewModel.processNodes, viewModel.finalNode]
      : viewModel.processNodes;
    const retained = new Set(nodes.map((node) => node.id));
    for (const id of this.markdown.keys()) {
      if (!retained.has(id)) this.markdown.delete(id);
    }
    for (const id of this.disclosures.keys()) {
      if (!retained.has(id)) this.disclosures.delete(id);
    }
    for (const node of nodes) {
      if (node.kind === "text") {
        const component = this.markdown.get(node.id);
        if (component) component.setText(node.markdown);
        else this.markdown.set(node.id, new MarkdownMessage(node.markdown, this.markdownTheme));
      }
      if (node.kind === "disclosure") {
        const component = this.disclosures.get(node.id);
        if (component) component.update(node.disclosure);
        else {
          this.disclosures.set(
            node.id,
            new DisclosureMessage(node.disclosure, disclosureUrl(node.disclosure.id), this.now),
          );
        }
      }
    }
  }
}
