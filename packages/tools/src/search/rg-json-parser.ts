import { truncateUtf8Text } from "../text/utf8";

const MAX_PREVIEW_BYTES = 512;

export interface ParsedRipgrepMatch {
  path: string;
  line: number;
  column: number;
  preview: string;
}

export interface ParsedRipgrepOutput {
  matches: readonly ParsedRipgrepMatch[];
  totalMatches?: number;
}

export function parseRipgrepJson(
  output: string,
  options: { allowTrailingPartial: boolean },
): ParsedRipgrepOutput {
  const lines = output.split("\n");
  const matches: ParsedRipgrepMatch[] = [];
  let totalMatches: number | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      const isTrailingPartial = index === lines.length - 1 && !output.endsWith("\n");
      if (options.allowTrailingPartial && isTrailingPartial) break;
      throw new Error("ripgrep returned invalid JSON output");
    }
    if (!isRecord(event) || typeof event.type !== "string" || !isRecord(event.data)) continue;
    if (event.type === "match") matches.push(parseMatch(event.data));
    if (event.type === "summary") {
      const stats = event.data.stats;
      if (isRecord(stats) && isNonNegativeInteger(stats.matched_lines)) {
        totalMatches = stats.matched_lines;
      }
    }
  }

  return { matches, totalMatches };
}

function parseMatch(data: Record<string, unknown>): ParsedRipgrepMatch {
  const path = decodeData(data.path);
  const preview = decodeData(data.lines).replace(/\r?\n$/, "");
  if (!isNonNegativeInteger(data.line_number) || data.line_number < 1) {
    throw new Error("ripgrep match is missing a valid line number");
  }
  if (!Array.isArray(data.submatches) || !isRecord(data.submatches[0])) {
    throw new Error("ripgrep match is missing submatch data");
  }
  const start = data.submatches[0].start;
  if (!isNonNegativeInteger(start)) throw new Error("ripgrep match has an invalid column");
  return {
    path,
    line: data.line_number,
    column: start + 1,
    preview: truncateUtf8Text(preview, MAX_PREVIEW_BYTES).text,
  };
}

function decodeData(value: unknown): string {
  if (!isRecord(value)) throw new Error("ripgrep JSON data is malformed");
  if (typeof value.text === "string") return value.text;
  if (typeof value.bytes === "string") return Buffer.from(value.bytes, "base64").toString("utf8");
  throw new Error("ripgrep JSON data is missing text");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
