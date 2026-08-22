import fs, { type FileHandle } from "node:fs/promises";
import {
  createAbortError,
  isAbortError,
  type AgentToolDefinition,
  type ToolResult,
} from "@omni-agent/core";
import { fileMutex } from "./file-mutex";
import { resolveAuthorizedOperationPath } from "../security/path/authorized-operation-path";
import { writeDirectFile } from "./io/direct-file-writer";
import { FileToolError, fileToolErrorResult } from "./io/file-errors";
import { createFileSnapshot, snapshotsEqual } from "./io/file-snapshot";
import {
  assertFileSize,
  assertTextValue,
  decodeTextFile,
  encodeTextFile,
} from "./io/text-file-validation";
import { createFilePathPermission } from "./permission/create-file-path-permission";
import { createFilePathPreflight } from "./permission/create-file-path-preflight";

const MAX_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_REPLACEMENT_LENGTH = 1024 * 1024;

export const fileEditTool: AgentToolDefinition = {
  name: "file_edit",
  strict: true,
  preflight: createFilePathPreflight({
    parameter: "file_path",
    acceptedKinds: ["regular_file"],
    operation: "edit",
  }),
  authorization: createFilePathPermission({ parameter: "file_path", access: "write" }),
  execution: { kind: "host" },
  invocation: { action: "edit", resource: { kind: "file", inputKey: "file_path" } },
  timeout: { kind: "none" },
  description:
    "Perform one exact, whitespace-sensitive replacement in a UTF-8 text file.\n\n" +
    "Usage:\n" +
    "- `old_string` must occur exactly once.\n" +
    "- Read the relevant complete text before editing; partial long-line chunks are not valid old_string values.\n" +
    "- The complete updated file is generated in memory before one direct write.\n" +
    "- `new_string` may be empty to delete the matched text.\n" +
    "- Use file_write for complete rewrites or new files.",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      file_path: { type: "string", minLength: 1, maxLength: 4096 },
      old_string: { type: "string", minLength: 1, maxLength: MAX_REPLACEMENT_LENGTH },
      new_string: { type: "string", maxLength: MAX_REPLACEMENT_LENGTH },
    },
    required: ["file_path", "old_string", "new_string"],
  },
  execute: async (params, context): Promise<ToolResult> => {
    try {
      const oldString = params.old_string as string;
      const newString = params.new_string as string;
      assertTextValue(oldString, MAX_REPLACEMENT_LENGTH);
      assertTextValue(newString, MAX_REPLACEMENT_LENGTH);
      const path = await resolveAuthorizedOperationPath(params.file_path as string, context.cwd);
      const result = await fileMutex.withLock(path, context.signal, async () => {
        const loaded = await loadStableText(path, context.signal);
        if (oldString === newString) {
          throw new FileToolError("no_change", "old_string and new_string are identical", false);
        }
        const match = findUniqueNonOverlappingMatch(loaded.text, oldString);
        if (match.kind === "none") {
          throw new FileToolError("match_not_found", "old_string was not found", false);
        }
        if (match.kind === "multiple") {
          throw new FileToolError("match_not_unique", "old_string is not unique", false);
        }
        const index = match.index;
        const updated =
          loaded.text.slice(0, index) + newString + loaded.text.slice(index + oldString.length);
        const bytes = encodeTextFile(updated, loaded.hasBom);
        assertFileSize(BigInt(bytes.length), MAX_TEXT_BYTES);
        await writeDirectFile({
          path,
          content: bytes,
          expected: loaded.snapshot,
          signal: context.signal,
        });
        const oldLines = countLines(oldString);
        const newLines = countLines(newString);
        return {
          line: lineNumberAt(loaded.text, index),
          addedLines: Math.max(0, newLines - oldLines),
          removedLines: Math.max(0, oldLines - newLines),
        };
      });
      return {
        content: [
          {
            type: "text",
            text: `Updated line ${result.line} (${result.addedLines} added, ${result.removedLines} removed)`,
          },
        ],
        isError: false,
        meta: {
          ...result,
          presentation: { resource: { kind: "file", path } },
        },
      };
    } catch (error) {
      if (isAbortError(error, context.signal)) throw createAbortError(context.signal);
      return fileToolErrorResult(
        error instanceof FileToolError
          ? error
          : new FileToolError("read_failed", "Failed to edit file", true),
      );
    }
  },
};

async function loadStableText(
  path: string,
  signal?: AbortSignal,
): Promise<{
  text: string;
  hasBom: boolean;
  snapshot: ReturnType<typeof createFileSnapshot>;
}> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(path, "r");
    const beforeStats = await handle.stat({ bigint: true });
    if (!beforeStats.isFile()) {
      throw new FileToolError("unsupported_file", "Target is not a regular file", false);
    }
    assertFileSize(beforeStats.size, MAX_TEXT_BYTES);
    const before = createFileSnapshot(beforeStats);
    const content = await handle.readFile({ signal });
    const after = createFileSnapshot(await handle.stat({ bigint: true }));
    if (!snapshotsEqual(before, after)) {
      throw new FileToolError("file_changed", "File changed while it was being read", true);
    }
    return { ...decodeTextFile(content), snapshot: before };
  } catch (error) {
    if (error instanceof FileToolError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new FileToolError("read_failed", "File not found", true);
    }
    throw new FileToolError("read_failed", "Failed to read file for editing", true);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

type UniqueMatch = { kind: "none" } | { kind: "unique"; index: number } | { kind: "multiple" };

function findUniqueNonOverlappingMatch(text: string, search: string): UniqueMatch {
  const first = text.indexOf(search);
  if (first < 0) return { kind: "none" };
  const second = text.indexOf(search, first + search.length);
  return second < 0 ? { kind: "unique", index: first } : { kind: "multiple" };
}

function countLines(text: string): number {
  return text.length === 0 ? 0 : text.split("\n").length;
}

function lineNumberAt(text: string, index: number): number {
  let line = 1;
  for (let position = 0; position < index; position += 1) {
    if (text.charCodeAt(position) === 0x0a) line += 1;
  }
  return line;
}
