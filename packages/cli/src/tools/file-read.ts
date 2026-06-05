import fs from "node:fs/promises";
import path from "node:path";
import type { AgentTool, ToolResult } from "@omni-agent/core";
import { fileMutex } from "./file-mutex";

export const fileReadTool: AgentTool = {
  name: "file_read",
  description:
    "Read a file and return its content with line numbers. " +
    "Supports optional offset (1-based line number) and limit (max lines to return).",
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
