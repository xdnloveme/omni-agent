import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import type { MarkdownTheme } from "@earendil-works/pi-tui";
import { MarkdownMessage } from "./markdown-message";

const identity = (text: string) => text;
const theme: MarkdownTheme = {
  heading: identity,
  link: identity,
  linkUrl: identity,
  code: identity,
  codeBlock: identity,
  codeBlockBorder: identity,
  quote: identity,
  quoteBorder: identity,
  hr: identity,
  listBullet: identity,
  bold: identity,
  italic: identity,
  strikethrough: identity,
  underline: identity,
  codeBlockIndent: "  ",
};

describe("MarkdownMessage", () => {
  it("renders fenced code as a terminal card without literal fences", () => {
    const markdown = new MarkdownMessage("Before\n\n```ts\nconst value = 1;\n```\n\nAfter", theme);
    const output = markdown.render(40).map(stripVTControlCharacters);

    expect(output.some((line) => line.includes("╭─ ts"))).toBe(true);
    expect(output.some((line) => line.includes("│ const value = 1;"))).toBe(true);
    expect(output.some((line) => line.includes("╰─"))).toBe(true);
    expect(output.some((line) => line.includes("```"))).toBe(false);
    expect(output.some((line) => line.trim() === "Before")).toBe(true);
    expect(output.some((line) => line.trim() === "After")).toBe(true);
  });

  it("uses a generic label when the fence has no language", () => {
    const markdown = new MarkdownMessage("```\nplain text\n```", theme);
    const output = markdown.render(30).map(stripVTControlCharacters);

    expect(output[0]).toContain("╭─ code");
  });
});
