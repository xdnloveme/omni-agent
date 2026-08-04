import fs from "node:fs/promises";
import path from "node:path";
import type { AgentTool, ToolResult } from "@omni-agent/core";
import { fileMutex } from "./file-mutex";

export const fileEditTool: AgentTool = {
  name: "file_edit",
  risk: "write",
  approval: "policy",
  description:
    "Perform an exact, whitespace-sensitive string replacement in a file.\n\n" +
    "Usage:\n" +
    "- Prefer file_edit over bash sed/awk for all file modifications — it's safer and more precise.\n" +
    "- `old_string` is matched literally (not regex) and must appear exactly once in the file.\n" +
    "- `new_string` replaces the matched text. Can be empty string to delete content.\n" +
    "- Always read the file first to get the exact text for `old_string`.\n" +
    "- Include enough surrounding context in `old_string` to ensure uniqueness.\n\n" +
    "When to use:\n" +
    "- Making targeted changes to existing files (fix bugs, update values, add code).\n" +
    "- Replacing specific code blocks, function bodies, or configuration values.\n\n" +
    "When NOT to use:\n" +
    "- Creating new files (use file_write instead).\n" +
    "- Rewriting an entire file (use file_write instead).\n" +
    "- When old_string appears multiple times — include more context to make it unique.",
  schema: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Absolute path to the file to edit",
      },
      old_string: {
        type: "string",
        description: "The exact text to find and replace (must be unique)",
      },
      new_string: {
        type: "string",
        description: "The replacement text",
      },
    },
    required: ["file_path", "old_string", "new_string"],
  },
  execute: async (params: Record<string, unknown>): Promise<ToolResult> => {
    const filePath = params.file_path as string;
    const oldString = params.old_string as string;
    const newString = params.new_string as string;

    if (!filePath) {
      return {
        content: [{ type: "text", text: "Error: file_path is required" }],
        isError: true,
      };
    }
    if (oldString == null || oldString === "") {
      return {
        content: [{ type: "text", text: "Error: old_string is required and must be non-empty" }],
        isError: true,
      };
    }
    if (newString == null) {
      return {
        content: [{ type: "text", text: "Error: new_string is required" }],
        isError: true,
      };
    }

    const resolved = path.resolve(filePath);

    try {
      const result = await fileMutex.withLock(resolved, async () => {
        const content = await fs.readFile(resolved, "utf-8");

        // Count occurrences
        let count = 0;
        let searchFrom = 0;
        while (true) {
          const idx = content.indexOf(oldString, searchFrom);
          if (idx === -1) break;
          count++;
          searchFrom = idx + 1;
        }

        if (count === 0) {
          return { error: "old_string not found in file" };
        }
        if (count > 1) {
          return { error: `old_string is not unique (found ${count} occurrences)` };
        }

        const updated = content.replace(oldString, newString);
        await fs.writeFile(resolved, updated, "utf-8");

        // Provide context around the change
        const changeIdx = content.indexOf(oldString);
        const linesBefore = content.slice(0, changeIdx).split("\n").length;
        const linesChanged = newString.split("\n").length;

        return {
          success: true,
          message: `Replaced at line ${linesBefore} (${linesChanged} line(s) in replacement)`,
        };
      });

      if ("error" in result) {
        return {
          content: [{ type: "text", text: `Error: ${result.error}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text", text: result.message }],
        isError: false,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error editing file: ${msg}` }],
        isError: true,
      };
    }
  },
};
