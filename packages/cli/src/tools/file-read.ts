import fs from "node:fs/promises";
import path from "node:path";
import type { AgentTool, ToolResult } from "@omni-agent/core";
import { fileMutex } from "./file-mutex";

export const fileReadTool: AgentTool = {
  name: "file_read",
  description:
    "Read a file and return its content with line numbers.\n\n" +
    "Usage:\n" +
    "- ALWAYS read a file before editing it to understand its current content.\n" +
    "- Returns content prefixed with line numbers in the format `line_number|content`.\n" +
    "- Use `offset` (1-based) and `limit` to read specific sections of large files.\n" +
    "- For files under ~500 lines, prefer reading the whole file in one call.\n\n" +
    "When to use:\n" +
    "- Understanding file content before making edits.\n" +
    "- Reviewing code structure, imports, or specific functions.\n" +
    "- Checking configuration files or documentation.\n\n" +
    "When NOT to use:\n" +
    "- Searching for patterns across many files (use grep instead).\n" +
    "- Finding files by name (use glob instead).",
  schema: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Absolute path to the file to read",
      },
      offset: {
        type: "number",
        description: "Starting line number (1-based). Defaults to 1.",
      },
      limit: {
        type: "number",
        description: "Maximum number of lines to return. Defaults to all.",
      },
    },
    required: ["file_path"],
  },
  execute: async (params: Record<string, unknown>): Promise<ToolResult> => {
    const filePath = params.file_path as string;
    if (!filePath) {
      return {
        content: [{ type: "text", text: "Error: file_path is required" }],
        isError: true,
      };
    }

    const resolved = path.resolve(filePath);

    try {
      const text = await fileMutex.withLock(resolved, () =>
        fs.readFile(resolved, "utf-8"),
      );

      const allLines = text.split("\n");
      const offset = Math.max(1, Number(params.offset) || 1);
      const limit =
        params.limit != null ? Number(params.limit) : allLines.length;

      const startIdx = offset - 1;
      const slice = allLines.slice(startIdx, startIdx + limit);

      const numbered = slice.map(
        (line, i) => `${offset + i}|${line}`,
      );

      return {
        content: [{ type: "text", text: numbered.join("\n") }],
        isError: false,
      };
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error reading file: ${msg}` }],
        isError: true,
      };
    }
  },
};
