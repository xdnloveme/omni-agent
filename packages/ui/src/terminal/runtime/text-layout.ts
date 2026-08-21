import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export function wrapTerminalText(text: string, columns: number): string {
  const terminalWidth = Math.max(20, columns || 80);
  const safeWidth = Math.max(10, terminalWidth - 2);
  const wrappedLines: string[] = [];
  for (const sourceLine of text.split("\n")) {
    const lines = wrapTextWithAnsi(sourceLine, safeWidth);
    if (lines.length === 0) {
      wrappedLines.push("");
      continue;
    }
    for (const line of lines) {
      if (visibleWidth(line) <= safeWidth) {
        wrappedLines.push(line);
      } else {
        wrappedLines.push(truncateToWidth(line, safeWidth, ""));
      }
    }
  }
  return wrappedLines.join("\n");
}
