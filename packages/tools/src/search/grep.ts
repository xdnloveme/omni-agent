import { type AgentToolDefinition, type ProcessResult, type ToolResult } from "@omni-agent/core";
import { formatFileSize, loadFileSizes } from "./file-metadata";
import { createSearchAccess } from "./access/create-search-access";
import { createSearchPathPreflight } from "./access/create-search-path-preflight";
import { parseRipgrepJson, type ParsedRipgrepMatch } from "./rg-json-parser";
import type { GrepFileMatches, GrepResultMeta } from "./types";

const DEFAULT_MAX_RESULTS = 50;
const MAX_RESULTS = 1000;
const MAX_PROCESS_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_BYTES = 50 * 1024;
const TRUNCATION_FOOTER = "[Results truncated. Narrow regex, glob, or path.]";

export const grepTool: AgentToolDefinition = {
  name: "grep",
  preflight: createSearchPathPreflight({
    parameter: "path",
    defaultToCwd: true,
    acceptedKinds: ["regular_file", "directory"],
  }),
  access: createSearchAccess({ parameter: "path", execution: "process" }),
  execution: { kind: "process" },
  invocation: { action: "search", resource: { kind: "text", inputKey: "regex" } },
  timeout: { kind: "none" },
  description:
    "Search file contents with ripgrep and return structured match locations.\n\n" +
    "Usage:\n" +
    "- Use this tool for content search instead of shelling out to `grep` or `rg`.\n" +
    "- Returns matching files with size, line, column, and a bounded preview.\n" +
    "- Use the returned line locations to read a focused range with file_read.\n" +
    "- Supports full regex syntax and optional glob filtering.\n" +
    "- Results are globally limited across all matching files.\n\n" +
    "When NOT to use:\n" +
    "- Finding files by name or pattern (use glob).\n" +
    "- Reading a file you already know the path to (use file_read).",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      regex: {
        type: "string",
        minLength: 1,
        maxLength: 4096,
        description: "Regular expression pattern to search for",
      },
      path: {
        type: "string",
        minLength: 1,
        maxLength: 4096,
        description: "File or directory to search in. Defaults to current working directory.",
      },
      glob: {
        type: "string",
        minLength: 1,
        maxLength: 4096,
        description: "Restrict search to files matching this glob (e.g. '*.ts', '**/*.py')",
      },
      ignore_case: {
        type: "boolean",
        description: "If true, perform a case-insensitive search",
      },
      max_results: {
        type: "integer",
        minimum: 1,
        maximum: MAX_RESULTS,
        description: `Global maximum number of matching lines to return. Defaults to ${DEFAULT_MAX_RESULTS}.`,
      },
    },
    required: ["regex"],
  },
  createProcessInvocation(params, context) {
    const regex = params.regex as string;
    const args = ["--json", "--line-number", "--column", "--color=never"];
    if (params.glob) args.push(`--glob=${params.glob as string}`);
    if (params.ignore_case) args.push("--ignore-case");
    args.push("--", regex, (params.path as string | undefined) ?? context.cwd);
    return {
      command: "rg",
      args,
      cwd: context.cwd,
      maxOutputBytes: MAX_PROCESS_OUTPUT_BYTES,
    };
  },
  createToolResult: (result, params, context) =>
    createGrepResult(
      result,
      (params.max_results as number | undefined) ?? DEFAULT_MAX_RESULTS,
      context.cwd,
      context.signal,
      context.outputs !== undefined,
    ),
};

async function createGrepResult(
  processResult: ProcessResult,
  maxResults: number,
  cwd: string,
  signal?: AbortSignal,
  retainOutput = false,
): Promise<ToolResult> {
  if (processResult.signal || (processResult.exitCode !== 0 && processResult.exitCode !== 1)) {
    const detail =
      processResult.stderr.trim() ||
      `ripgrep exited with ${processResult.signal ?? `code ${processResult.exitCode}`}`;
    return { content: [{ type: "text", text: `ripgrep error: ${detail}` }], isError: true };
  }
  if (processResult.exitCode === 1) return noMatchesResult();
  const parsed = parseRipgrepJson(processResult.stdout, {
    allowTrailingPartial: processResult.stdoutTruncated,
  });
  if (parsed.matches.length === 0) {
    return processResult.stdoutTruncated ? truncatedWithoutMatchesResult() : noMatchesResult();
  }
  const candidates = parsed.matches.slice(0, maxResults);
  const selectedFiles = retainOutput
    ? groupMatches(candidates)
    : selectFilesForDisplay(groupMatches(candidates));
  const sizes = await loadFileSizes(
    selectedFiles.map((file) => file.path),
    cwd,
    signal,
  );
  const files = selectedFiles.map((file) => ({
    ...file,
    sizeBytes: sizes.get(file.path) ?? null,
  }));
  const selectedMatches = countMatches(files);
  const sourceTruncated =
    processResult.stdoutTruncated ||
    parsed.matches.length > maxResults ||
    selectedMatches < candidates.length ||
    (parsed.totalMatches !== undefined && parsed.totalMatches > selectedMatches);
  const formatted = formatGrepResult(files, parsed.totalMatches, sourceTruncated);
  return {
    content: [{ type: "text", text: formatted.text }],
    isError: false,
    meta: formatted.meta,
  };
}

function formatGrepResult(
  files: readonly GrepFileMatches[],
  totalMatches: number | undefined,
  truncated: boolean,
): { text: string; meta: GrepResultMeta } {
  const headline =
    totalMatches === undefined ? "Matching lines:" : `Found ${totalMatches} matching lines:`;
  const lines = [headline];
  for (const file of files) {
    lines.push(`${file.path} (${formatFileSize(file.sizeBytes)})`);
    for (const match of file.matches) {
      lines.push(`  ${match.line}:${match.column}  ${match.preview}`);
    }
  }
  if (truncated) lines.push(TRUNCATION_FOOTER);
  const returnedMatches = countMatches(files);
  return {
    text: lines.join("\n"),
    meta: {
      files,
      returnedMatches,
      ...(totalMatches === undefined ? {} : { totalMatches }),
      truncated,
    },
  };
}

function groupMatches(matches: readonly ParsedRipgrepMatch[]): GrepFileMatches[] {
  interface MutableGrepFile {
    path: string;
    sizeBytes: number | null;
    matches: Array<GrepFileMatches["matches"][number]>;
  }
  const files = new Map<string, MutableGrepFile>();
  for (const match of matches) {
    const file = files.get(match.path) ?? {
      path: match.path,
      sizeBytes: null,
      matches: [],
    };
    file.matches.push({
      line: match.line,
      column: match.column,
      preview: match.preview,
    });
    files.set(match.path, file);
  }
  for (const file of files.values()) {
    file.matches.sort((left, right) => left.line - right.line || left.column - right.column);
  }
  return [...files.values()];
}

function selectFilesForDisplay(files: readonly GrepFileMatches[]): GrepFileMatches[] {
  const conservativeHeadline = `Found ${Number.MAX_SAFE_INTEGER} matching lines:`;
  const contentBudget = MAX_TEXT_BYTES - Buffer.byteLength(TRUNCATION_FOOTER) - 1;
  let usedBytes = Buffer.byteLength(conservativeHeadline);
  const selected: GrepFileMatches[] = [];

  for (const file of files) {
    const header = `${file.path} (size unavailable)`;
    const matches = [];
    for (const match of file.matches) {
      const matchLine = `  ${match.line}:${match.column}  ${match.preview}`;
      const addition = `${matches.length === 0 ? `\n${header}` : ""}\n${matchLine}`;
      if (usedBytes + Buffer.byteLength(addition) > contentBudget) break;
      usedBytes += Buffer.byteLength(addition);
      matches.push(match);
    }
    if (matches.length > 0) selected.push({ ...file, matches });
    if (matches.length < file.matches.length) break;
  }
  return selected;
}

function countMatches(files: readonly GrepFileMatches[]): number {
  return files.reduce((count, file) => count + file.matches.length, 0);
}

function noMatchesResult(): ToolResult {
  return {
    content: [{ type: "text", text: "No matches found." }],
    isError: false,
    meta: { files: [], returnedMatches: 0, totalMatches: 0, truncated: false },
  };
}

function truncatedWithoutMatchesResult(): ToolResult {
  return {
    content: [
      {
        type: "text",
        text:
          "Search output was truncated before a complete match could be decoded. " +
          "Narrow regex, glob, or path.",
      },
    ],
    isError: false,
    meta: { files: [], returnedMatches: 0, truncated: true },
  };
}
