import {
  hyperlink,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import { formatSanitizedToolInput, sanitizeSensitiveValue } from "@omni-agent/core";
import chalk from "chalk";

const MAX_OUTPUT_CHARS = 50_000;
const MAX_OUTPUT_LINES = 200;

export interface ToolMessageResult {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
}

interface ToolInputPresentation {
  summary: string;
  detail: string;
  summaryKind: "code" | "plain";
  completion: "collapsed" | "temporary-preview";
}

function indentWrapped(text: string, width: number, prefix: string): string[] {
  const contentWidth = Math.max(10, width - visibleWidth(prefix));
  const sourceLines = text.split("\n");
  const result: string[] = [];

  for (const sourceLine of sourceLines) {
    const wrapped = wrapTextWithAnsi(sourceLine, contentWidth);
    if (wrapped.length === 0) {
      result.push(prefix);
      continue;
    }
    result.push(...wrapped.map((line) => `${prefix}${line}`));
  }

  return result;
}

function collectOutput(result: ToolMessageResult): string {
  const complete = result.content
    .filter((block) => block.type === "text" && block.text)
    .map((block) => block.text)
    .join("\n");
  const clippedChars = complete.slice(0, MAX_OUTPUT_CHARS);
  const lines = clippedChars.split("\n");
  const clippedLines = lines.slice(0, MAX_OUTPUT_LINES);
  const omittedLines = Math.max(0, lines.length - clippedLines.length);
  const omittedChars = Math.max(0, complete.length - clippedChars.length);

  if (omittedLines > 0 || omittedChars > 0) {
    clippedLines.push(
      `… output truncated${omittedLines > 0 ? ` (${omittedLines} more lines)` : ""}${
        omittedChars > 0 ? ` (${omittedChars.toLocaleString()} more characters)` : ""
      }`,
    );
  }

  return clippedLines.join("\n");
}

/** A compact tool invocation row with an optional, bounded result body. */
export class ToolMessage implements Component {
  private result: ToolMessageResult | null = null;
  private durationMs: number | null = null;
  private autoCollapsePending = false;
  private expanded = false;
  private readonly presentation: ToolInputPresentation;

  constructor(
    private readonly toolName: string,
    input: Record<string, unknown>,
    private readonly linkUrl?: string,
  ) {
    this.presentation = createInputPresentation(input);
  }

  finish(result: ToolMessageResult, durationMs: number): boolean {
    this.result = result;
    this.durationMs = durationMs;
    this.autoCollapsePending = this.presentation.completion === "temporary-preview";
    this.expanded = this.autoCollapsePending;
    return this.autoCollapsePending;
  }

  collapsePreview(): void {
    if (!this.autoCollapsePending) return;
    this.autoCollapsePending = false;
    this.expanded = false;
  }

  toggleDetails(): void {
    if (!this.result) return;
    this.autoCollapsePending = false;
    this.expanded = !this.expanded;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(20, width);
    const marker = this.expanded && this.result ? "▼" : "▶";
    const state = this.renderState();
    const fixed = `${marker} ${this.toolName}  ${state}`;
    const previewWidth = Math.max(0, safeWidth - visibleWidth(fixed) - 2);
    const summary =
      this.presentation.summaryKind === "code"
        ? chalk.yellow(this.presentation.summary)
        : chalk.dim(this.presentation.summary);
    const preview = previewWidth > 8 ? ` ${truncateToWidth(summary, previewWidth, "…")}` : "";
    const header = truncateToWidth(
      `${marker} ${chalk.bold(this.toolName)}${preview}  ${state}`,
      safeWidth,
    );
    const lines = [this.linkUrl ? hyperlink(header, this.linkUrl) : header];

    if (!this.expanded || !this.result) return lines;

    lines.push(
      ...indentWrapped(chalk.dim(`input: ${this.presentation.detail}`), safeWidth, chalk.dim("│ ")),
    );
    const output = collectOutput(this.result);
    if (output) {
      lines.push(chalk.dim("│ output:"));
      lines.push(...indentWrapped(chalk.dim(output), safeWidth, chalk.dim("│   ")));
    } else {
      lines.push(chalk.dim("│ (no text output)"));
    }
    lines.push(
      chalk.dim(
        this.autoCollapsePending
          ? "└─ result received · auto-collapsing"
          : "└─ click the header to collapse",
      ),
    );
    return lines;
  }

  private renderState(): string {
    if (!this.result || this.durationMs === null) return chalk.cyan("running…");
    const status = this.result.isError ? chalk.red("✗ error") : chalk.green("✓ done");
    return `${status} ${chalk.dim(`(${this.durationMs}ms)`)}${
      this.expanded ? "" : chalk.dim(" · click for details")
    }`;
  }
}

function createInputPresentation(input: Record<string, unknown>): ToolInputPresentation {
  const sanitizedInput = sanitizeSensitiveValue(input) as Record<string, unknown>;
  const detail = formatSanitizedToolInput(sanitizedInput);
  const filePath = sanitizedInput.file_path;
  if (typeof filePath === "string" && filePath.length > 0) {
    return {
      summary: filePath,
      detail,
      summaryKind: "code",
      completion: "collapsed",
    };
  }
  return {
    summary: detail,
    detail,
    summaryKind: "plain",
    completion: "temporary-preview",
  };
}
