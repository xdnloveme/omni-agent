import fs from "node:fs/promises";
import path from "node:path";
import type { AgentToolDefinition, ToolResult } from "@omni-agent/core";
import { fileMutex } from "./file-mutex";
import { createFilePathPermission } from "./permission/create-file-path-permission";
import { resolveToolPath } from "../security/path/normalize-path";

export const fileWriteTool: AgentToolDefinition = {
  name: "file_write",
  strict: true,
  authorization: {
    ...createFilePathPermission({ parameter: "file_path", access: "write" }),
    hiddenInputKeys: ["content"],
  },
  execution: { kind: "host" },
  description:
    "Create or overwrite a file with the given content.\n\n" +
    "Usage:\n" +
    "- Creates parent directories automatically if they don't exist.\n" +
    "- Overwrites the file entirely if it already exists — use file_edit for partial changes.\n" +
    "- Use absolute paths for reliability.\n\n" +
    "When to use:\n" +
    "- Creating new files (source code, configs, scripts).\n" +
    "- Completely rewriting a file when most content changes.\n\n" +
    "When NOT to use:\n" +
    "- Making small, targeted edits to existing files (use file_edit instead — it's safer).\n" +
    "- Appending to a file (read first with file_read, then write the combined content).",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      file_path: {
        type: "string",
        minLength: 1,
        maxLength: 4096,
        description: "Absolute path to the file to write",
      },
      content: {
        type: "string",
        description: "The content to write to the file",
      },
    },
    required: ["file_path", "content"],
  },
  execute: async (params, context): Promise<ToolResult> => {
    const filePath = params.file_path as string;
    const content = params.content as string;

    if (!filePath) {
      return {
        content: [{ type: "text", text: "Error: file_path is required" }],
        isError: true,
      };
    }
    if (content == null) {
      return {
        content: [{ type: "text", text: "Error: content is required" }],
        isError: true,
      };
    }

    const resolved = resolveToolPath(filePath, context.cwd);

    try {
      await fileMutex.withLock(resolved, async () => {
        await fs.mkdir(path.dirname(resolved), { recursive: true });
        await fs.writeFile(resolved, content, "utf-8");
      });

      const bytes = Buffer.byteLength(content, "utf-8");
      return {
        content: [{ type: "text", text: `Successfully wrote ${bytes} bytes to ${resolved}` }],
        isError: false,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error writing file: ${msg}` }],
        isError: true,
      };
    }
  },
};
