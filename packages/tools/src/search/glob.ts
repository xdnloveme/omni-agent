import path from "node:path";
import fg from "fast-glob";
import type { AgentTool, ToolResult } from "@omni-agent/core";

const MAX_RESULTS = 200;

export const globTool: AgentTool = {
  name: "glob",
  risk: "read",
  approval: "never",
  description:
    "Fast file pattern matching tool for discovering files by name or path pattern.\n\n" +
    "Usage:\n" +
    "- ALWAYS use glob for finding files by pattern. NEVER use `find` or `ls` in bash for file discovery.\n" +
    "- Pattern syntax: `*` matches within a directory, `**` matches recursively across directories, " +
    "`{}` for brace expansion (e.g. `*.{js,ts}`).\n" +
    "- Examples: `**/*.ts` (all TypeScript files), `src/**/*.{js,ts}` (JS/TS under src/), " +
    "`*.config.*` (config files in cwd).\n" +
    "- Respects .gitignore by default — node_modules and other ignored paths are excluded.\n" +
    "- Returns relative file paths from the search directory.\n" +
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
    properties: {
      pattern: {
        type: "string",
        description:
          "Glob pattern to match files (e.g. '**/*.ts', 'src/**/*.{js,ts}')",
      },
      dir_path: {
        type: "string",
        description:
          "Directory to search in. Defaults to current working directory.",
      },
      exclude: {
        type: "array",
        items: { type: "string" },
        description:
          "Patterns to exclude (e.g. ['node_modules/**', '*.test.ts'])",
      },
    },
    required: ["pattern"],
  },
  execute: async (params: Record<string, unknown>): Promise<ToolResult> => {
    const pattern = params.pattern as string;
    if (!pattern) {
      return {
        content: [{ type: "text", text: "Error: pattern is required" }],
        isError: true,
      };
    }

    const cwd = params.dir_path
      ? path.resolve(params.dir_path as string)
      : process.cwd();

    const exclude = (params.exclude as string[] | undefined) ?? [];

    try {
      const entries = await fg(pattern, {
        cwd,
        ignore: exclude,
        dot: false,
        onlyFiles: true,
        followSymbolicLinks: false,
      });

      const truncated = entries.length > MAX_RESULTS;
      const results = truncated ? entries.slice(0, MAX_RESULTS) : entries;

      const header = truncated
        ? `Found ${entries.length} files (showing first ${MAX_RESULTS}):\n`
        : `Found ${entries.length} file${entries.length === 1 ? "" : "s"}:\n`;

      if (entries.length === 0) {
        return {
          content: [{ type: "text", text: "No files matched the pattern." }],
          isError: false,
        };
      }

      return {
        content: [{ type: "text", text: header + results.join("\n") }],
        isError: false,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error running glob: ${msg}` }],
        isError: true,
      };
    }
  },
};
