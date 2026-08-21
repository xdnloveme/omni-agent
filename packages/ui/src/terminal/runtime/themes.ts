import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@earendil-works/pi-tui";
import chalk from "chalk";

const selectListTheme: SelectListTheme = {
  selectedPrefix: (text) => chalk.bold(chalk.blue(`> ${text}`)),
  selectedText: (text) => chalk.bold(chalk.blue(text)),
  description: (text) => chalk.dim(text),
  scrollInfo: (text) => chalk.dim(text),
  noMatch: (text) => chalk.dim(text),
};

export const editorTheme: EditorTheme = {
  borderColor: (text) => chalk.dim(text),
  selectList: selectListTheme,
};

export const markdownTheme: MarkdownTheme = {
  heading: (text) => chalk.bold(chalk.cyan(text)),
  link: (text) => chalk.underline(chalk.blue(text)),
  linkUrl: (text) => chalk.dim(text),
  code: (text) => chalk.yellow(text),
  codeBlock: (text) => chalk.gray(text),
  codeBlockBorder: (text) => chalk.dim(text),
  quote: (text) => chalk.italic(chalk.gray(text)),
  quoteBorder: (text) => chalk.dim(text),
  hr: (text) => chalk.dim(text),
  listBullet: (text) => chalk.cyan(text),
  bold: (text) => chalk.bold(text),
  italic: (text) => chalk.italic(text),
  strikethrough: (text) => chalk.strikethrough(text),
  underline: (text) => chalk.underline(text),
  codeBlockIndent: "  ",
};
