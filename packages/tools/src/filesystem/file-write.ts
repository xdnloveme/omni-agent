import fs from "node:fs/promises";
import path from "node:path";
import {
  createAbortError,
  isAbortError,
  throwIfAborted,
  type AgentToolDefinition,
  type ToolResult,
} from "@omni-agent/core";
import { fileMutex } from "./file-mutex";
import { resolveAuthorizedOperationPath } from "../security/path/authorized-operation-path";
import { writeDirectFile } from "./io/direct-file-writer";
import { FileToolError, fileToolErrorResult } from "./io/file-errors";
import { createFileSnapshot } from "./io/file-snapshot";
import { assertFileSize, encodeTextFile } from "./io/text-file-validation";
import { createFileAccess } from "./access/create-file-access";
import { createFilePathPreflight } from "./access/create-file-path-preflight";

const MAX_CONTENT_BYTES = 8 * 1024 * 1024;

export const fileWriteTool: AgentToolDefinition = {
  name: "file_write",
  strict: true,
  preflight: createFilePathPreflight({
    parameter: "file_path",
    acceptedKinds: ["regular_file", "missing"],
    operation: "write",
  }),
  access: createFileAccess({
    parameter: "file_path",
    access: "write",
    hiddenInputKeys: ["content"],
  }),
  execution: { kind: "in_process" },
  invocation: { action: "write", resource: { kind: "file", inputKey: "file_path" } },
  timeout: { kind: "none" },
  description:
    "Create or completely overwrite a UTF-8 text file.\n\n" +
    "Usage:\n" +
    "- Creates parent directories when necessary.\n" +
    "- Generates the complete byte content before one direct write.\n" +
    "- Use file_edit for targeted changes to existing files.\n" +
    "- Maximum content size is 8 MiB.",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      file_path: { type: "string", minLength: 1, maxLength: 4096 },
      content: { type: "string", maxLength: MAX_CONTENT_BYTES },
    },
    required: ["file_path", "content"],
  },
  execute: async (params, context): Promise<ToolResult> => {
    try {
      const requested = params.file_path as string;
      throwIfAborted(context.signal);
      const bytes = encodeTextFile(params.content as string);
      assertFileSize(BigInt(bytes.length), MAX_CONTENT_BYTES);
      throwIfAborted(context.signal);
      const authorized = await resolveAuthorizedOperationPath(requested, context.cwd);
      await fs.mkdir(path.dirname(authorized), { recursive: true });
      throwIfAborted(context.signal);
      const canonical = await resolveAuthorizedOperationPath(authorized, context.cwd);
      const result = await fileMutex.withLock(canonical, context.signal, async () => {
        const expected = await captureExpectedTarget(canonical);
        return writeDirectFile({
          path: canonical,
          content: bytes,
          expected,
          signal: context.signal,
        });
      });
      return {
        content: [
          { type: "text", text: `Successfully wrote ${result.bytesWritten} bytes to ${canonical}` },
        ],
        isError: false,
        meta: {
          bytesWritten: result.bytesWritten,
          path: canonical,
          presentation: { resource: { kind: "file", path: canonical } },
        },
      };
    } catch (error) {
      if (isAbortError(error, context.signal)) throw createAbortError(context.signal);
      return fileToolErrorResult(
        error instanceof FileToolError
          ? error
          : new FileToolError("write_failed", "Failed to write file", false, {
              targetState: "unknown",
            }),
      );
    }
  },
};

async function captureExpectedTarget(
  target: string,
): Promise<ReturnType<typeof createFileSnapshot> | "missing"> {
  try {
    const stats = await fs.stat(target, { bigint: true });
    if (!stats.isFile()) {
      throw new FileToolError("unsupported_file", "Target is not a regular file", false);
    }
    return createFileSnapshot(stats);
  } catch (error) {
    if (error instanceof FileToolError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw new FileToolError("write_failed", "Unable to inspect target file", false, {
      targetState: "unknown",
    });
  }
}
