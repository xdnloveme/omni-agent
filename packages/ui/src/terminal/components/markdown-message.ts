import {
  Markdown,
  truncateToWidth,
  visibleWidth,
  type Component,
  type MarkdownTheme,
} from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import chalk from "chalk";

const CODE_BACKGROUND = 236;

function fill(text: string, width: number): string {
  const clipped = truncateToWidth(text, width, "");
  return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

/** Markdown renderer with terminal-native fenced code cards. */
export class MarkdownMessage implements Component {
  private readonly markdown: Markdown;

  constructor(text: string, theme: MarkdownTheme) {
    this.markdown = new Markdown(text, 0, 0, theme);
  }

  setText(text: string): void {
    this.markdown.setText(text);
  }

  invalidate(): void {
    this.markdown.invalidate();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const rendered = this.markdown.render(safeWidth);
    const result: string[] = [];
    let insideCodeBlock = false;

    for (const renderedLine of rendered) {
      const plainLine = stripVTControlCharacters(renderedLine).trimEnd();
      if (plainLine.startsWith("```")) {
        if (!insideCodeBlock) {
          insideCodeBlock = true;
          const language = plainLine.slice(3).trim() || "code";
          const label = `╭─ ${language} `;
          const border = `${label}${"─".repeat(Math.max(0, safeWidth - visibleWidth(label)))}`;
          result.push(chalk.bgAnsi256(CODE_BACKGROUND)(chalk.dim(border)));
        } else {
          insideCodeBlock = false;
          result.push(chalk.bgAnsi256(CODE_BACKGROUND)(chalk.dim(`╰${"─".repeat(safeWidth - 1)}`)));
        }
        continue;
      }

      if (insideCodeBlock) {
        const unpadded = renderedLine.trimEnd();
        const code = unpadded.startsWith("  ") ? unpadded.slice(2) : unpadded;
        result.push(chalk.bgAnsi256(CODE_BACKGROUND)(fill(`${chalk.dim("│ ")}${code}`, safeWidth)));
        continue;
      }

      result.push(renderedLine);
    }

    return result;
  }
}
