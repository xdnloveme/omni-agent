import fs from "node:fs/promises";
import type { AgentToolDefinition, ToolResult } from "@omni-agent/core";
import { fileMutex } from "./file-mutex";
import { createFilePathPermission } from "./permission/create-file-path-permission";
import { resolveToolPath } from "../security/path/normalize-path";

export const fileReadTool: AgentToolDefinition = {
  name: "file_read",
  strict: true,
  authorization: createFilePathPermission({ parameter: "file_path", access: "read" }),
  execution: { kind: "host" },
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
    additionalProperties: false,
    properties: {
      file_path: {
        type: "string",
        minLength: 1,
        maxLength: 4096,
        description: "Absolute path to the file to read",
      },
      offset: {
        type: "integer",
        minimum: 1,
        description: "Starting line number (1-based). Defaults to 1.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        description: "Maximum number of lines to return. Defaults to all.",
      },
    },
    required: ["file_path"],
  },
  execute: async (params, context): Promise<ToolResult> => {
    const filePath = params.file_path as string;
    if (!filePath) {
      return {
        content: [{ type: "text", text: "Error: file_path is required" }],
        isError: true,
      };
    }

    const resolved = resolveToolPath(filePath, context.cwd);

    try {
      const text = await fileMutex.withLock(resolved, () => fs.readFile(resolved, "utf-8"));

      const allLines = text.split("\n");
      const offset = Math.max(1, Number(params.offset) || 1);
      const limit = params.limit != null ? Number(params.limit) : allLines.length;

      const startIdx = offset - 1;
      const slice = allLines.slice(startIdx, startIdx + limit);

      const numbered = slice.map((line, i) => `${offset + i}|${line}`);

      return {
        content: [{ type: "text", text: numbered.join("\n") }],
        isError: false,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error reading file: ${msg}` }],
        isError: true,
      };
    }
  },
};
