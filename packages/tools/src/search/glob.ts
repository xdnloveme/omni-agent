import fg from "fast-glob";
import {
  createAbortError,
  isAbortError,
  type AgentToolDefinition,
  type ToolResult,
} from "@omni-agent/core";
import { formatFileSize, loadFileSizes } from "./file-metadata";
import { resolveAuthorizedOperationPath } from "../security/path/authorized-operation-path";
import { createSearchPathPermission } from "./permission/create-search-path-permission";
import { createSearchPathPreflight } from "./permission/create-search-path-preflight";
import type { GlobResultMeta } from "./types";

const MAX_RESULTS = 200;

export const globTool: AgentToolDefinition = {
  name: "glob",
  preflight: createSearchPathPreflight({
    parameter: "dir_path",
    defaultToCwd: true,
    acceptedKinds: ["directory"],
  }),
  authorization: createSearchPathPermission("dir_path"),
  execution: { kind: "host" },
  invocation: { action: "search", resource: { kind: "text", inputKey: "pattern" } },
  timeout: { kind: "none" },
  description:
    "Fast file pattern matching tool for discovering files by name or path pattern.\n\n" +
    "Usage:\n" +
    "- Use this tool for file discovery instead of shelling out to `find` or `ls`.\n" +
    "- Pattern syntax: `*` matches within a directory, `**` matches recursively across directories, " +
    "`{}` for brace expansion (e.g. `*.{js,ts}`).\n" +
    "- Examples: `**/*.ts` (all TypeScript files), `src/**/*.{js,ts}` (JS/TS under src/), " +
    "`*.config.*` (config files in cwd).\n" +
    "- Hidden entries are excluded by default; use `exclude` for dependency or generated paths.\n" +
    "- Returns relative file paths and file sizes from the search directory.\n" +
    "- Use `exclude` to filter out specific patterns (e.g. test files, generated code).\n\n" +
    "When to use:\n" +
    "- Finding files by extension or naming pattern.\n" +
    "- Discovering project structure.\n" +
    "- Locating config files, test files, or source files.\n\n" +
    "When NOT to use:\n" +
    "- Searching file contents (use grep instead).\n" +
    "- Reading a file you already know the path to (use file_read).",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      pattern: {
        type: "string",
        minLength: 1,
        maxLength: 4096,
        description: "Glob pattern to match files (e.g. '**/*.ts', 'src/**/*.{js,ts}')",
      },
      dir_path: {
        type: "string",
        minLength: 1,
        maxLength: 4096,
        description: "Directory to search in. Defaults to current working directory.",
      },
      exclude: {
        type: "array",
        maxItems: 100,
        items: { type: "string", minLength: 1, maxLength: 4096 },
        description: "Patterns to exclude (e.g. ['node_modules/**', '*.test.ts'])",
      },
    },
    required: ["pattern"],
  },
  execute: async (params, context): Promise<ToolResult> => {
    const pattern = params.pattern as string;
    if (!pattern) {
      return {
        content: [{ type: "text", text: "Error: pattern is required" }],
        isError: true,
      };
    }

    const exclude = (params.exclude as string[] | undefined) ?? [];

    try {
      const cwd = params.dir_path
        ? await resolveAuthorizedOperationPath(params.dir_path as string, context.cwd)
        : context.cwd;
      const entries = await fg(pattern, {
        cwd,
        ignore: exclude,
        dot: false,
        onlyFiles: true,
        followSymbolicLinks: false,
      });

      entries.sort(comparePaths);
      const truncated = entries.length > MAX_RESULTS;
      const results = entries.slice(0, MAX_RESULTS);
      const sizes = await loadFileSizes(results, cwd, context.signal);
      const files = results.map((filePath) => ({
        path: filePath,
        sizeBytes: sizes.get(filePath) ?? null,
      }));

      const header = truncated
        ? `Found ${entries.length} files (showing first ${MAX_RESULTS}):\n`
        : `Found ${entries.length} file${entries.length === 1 ? "" : "s"}:\n`;

      if (entries.length === 0) {
        return {
          content: [{ type: "text", text: "No files matched the pattern." }],
          isError: false,
          meta: {
            files: [],
            totalMatches: 0,
            returnedFiles: 0,
            truncated: false,
          } satisfies GlobResultMeta,
        };
      }

      return {
        content: [
          {
            type: "text",
            text:
              header +
              files.map((file) => `${file.path} (${formatFileSize(file.sizeBytes)})`).join("\n"),
          },
        ],
        isError: false,
        meta: {
          files,
          totalMatches: entries.length,
          returnedFiles: files.length,
          truncated,
        } satisfies GlobResultMeta,
      };
    } catch (err: unknown) {
      if (isAbortError(err, context.signal)) throw createAbortError(context.signal);
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error running glob: ${msg}` }],
        isError: true,
      };
    }
  },
};

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
