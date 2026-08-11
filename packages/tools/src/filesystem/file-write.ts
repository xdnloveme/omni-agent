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
import { resolveCanonicalOperationPath } from "./io/canonical-operation-path";
import { writeDirectFile } from "./io/direct-file-writer";
import { FileToolError, fileToolErrorResult } from "./io/file-errors";
import { createFileSnapshot } from "./io/file-snapshot";
import { assertFileSize, encodeTextFile } from "./io/text-file-validation";
import { createFilePathPermission } from "./permission/create-file-path-permission";

const MAX_CONTENT_BYTES = 8 * 1024 * 1024;

export const fileWriteTool: AgentToolDefinition = {
  name: "file_write",
  strict: true,
  authorization: {
    ...createFilePathPermission({ parameter: "file_path", access: "write" }),
    hiddenInputKeys: ["content"],
  },
  execution: { kind: "host" },
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
      const unresolved = path.resolve(context.cwd, requested);
      throwIfAborted(context.signal);
      await fs.mkdir(path.dirname(unresolved), { recursive: true });
      throwIfAborted(context.signal);
      const canonical = await resolveCanonicalOperationPath(requested, context.cwd);
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
        meta: { bytesWritten: result.bytesWritten, path: canonical },
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
