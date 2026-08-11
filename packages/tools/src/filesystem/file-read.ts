import {
  createAbortError,
  isAbortError,
  type AgentToolDefinition,
  type ToolResult,
} from "@omni-agent/core";
import { fileMutex } from "./file-mutex";
import { resolveCanonicalOperationPath } from "./io/canonical-operation-path";
import { FileToolError, fileToolErrorResult } from "./io/file-errors";
import { readTextPage } from "./io/streaming-line-reader";
import { createFilePathPermission } from "./permission/create-file-path-permission";

const DEFAULT_LIMIT = 200;

export const fileReadTool: AgentToolDefinition = {
  name: "file_read",
  strict: true,
  authorization: createFilePathPermission({ parameter: "file_path", access: "read" }),
  execution: { kind: "host" },
  timeout: { kind: "none" },
  description:
    "Read a UTF-8 text file with bounded, version-consistent pagination.\n\n" +
    "Usage:\n" +
    "- Returns lines as `line_number|content`.\n" +
    "- Defaults to 200 lines and never returns more than 64 KiB.\n" +
    "- Use the exact continuation parameters returned in the footer.\n" +
    "- Long lines are returned in byte-aligned chunks instead of failing.\n" +
    "- Use grep to locate relevant line numbers in large files.\n\n" +
    "When NOT to use:\n" +
    "- Searching across files (use grep).\n" +
    "- Finding files by name (use glob).",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      file_path: {
        type: "string",
        minLength: 1,
        maxLength: 4096,
        description: "Absolute or workspace-relative path to the file",
      },
      offset: {
        type: "integer",
        minimum: 1,
        maximum: Number.MAX_SAFE_INTEGER,
        description: "Starting logical line number. Defaults to 1.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 1000,
        description: "Maximum lines to return. Defaults to 200.",
      },
      line_byte_offset: {
        type: "integer",
        minimum: 1,
        description: "UTF-8 byte offset within a long physical line",
      },
      file_version: {
        type: "string",
        minLength: 1,
        maxLength: 128,
        description: "Opaque version returned by the previous page",
      },
    },
    required: ["file_path"],
  },
  execute: async (params, context): Promise<ToolResult> => {
    const offset = (params.offset as number | undefined) ?? 1;
    const limit = (params.limit as number | undefined) ?? DEFAULT_LIMIT;
    const lineByteOffset = params.line_byte_offset as number | undefined;
    const fileVersion = params.file_version as string | undefined;
    if (
      lineByteOffset !== undefined &&
      (params.offset === undefined ||
        fileVersion === undefined ||
        (params.limit !== undefined && limit !== 1))
    ) {
      return fileToolErrorResult(
        new FileToolError(
          "invalid_pagination",
          "line_byte_offset requires offset, file_version, and limit omitted or equal to 1",
          false,
        ),
      );
    }

    try {
      const path = await resolveCanonicalOperationPath(params.file_path as string, context.cwd);
      const result = await fileMutex.withLock(path, context.signal, () =>
        readTextPage({
          path,
          offset,
          limit: lineByteOffset === undefined ? limit : 1,
          lineByteOffset,
          fileVersion,
          signal: context.signal,
        }),
      );
      return {
        content: [{ type: "text", text: result.text }],
        isError: false,
        meta: { pagination: result.pagination },
      };
    } catch (error) {
      if (isAbortError(error, context.signal)) throw createAbortError(context.signal);
      return fileToolErrorResult(
        error instanceof FileToolError
          ? error
          : new FileToolError("read_failed", "Failed to read file", true),
      );
    }
  },
};
