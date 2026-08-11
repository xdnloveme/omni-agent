import path from "node:path";
import {
  createAbortError,
  isAbortError,
  type AgentToolDefinition,
  type ToolResult,
} from "@omni-agent/core";
import { runHostProcess } from "../process/host-process-runner";
import { createSearchPathPermission } from "./permission/create-search-path-permission";

const DEFAULT_MAX_RESULTS = 50;
const MAX_OUTPUT_BYTES = 51_200; // 50KB

export const grepTool: AgentToolDefinition = {
  name: "grep",
  authorization: createSearchPathPermission("search_path"),
  execution: { kind: "host" },
  timeout: { kind: "none" },
  description:
    "A powerful content search tool built on ripgrep for finding text patterns in files.\n\n" +
    "Usage:\n" +
    "- ALWAYS use grep for content search. NEVER invoke `grep` or `rg` as a bash command.\n" +
    "- Supports full regex syntax (e.g. `log.*Error`, `function\\s+\\w+`, `import.*from`).\n" +
    "- Filter files with the `glob` parameter (e.g. `*.ts`, `**/*.py`, `src/**/*.{js,jsx}`).\n" +
    "- Returns matches in the format `file:line_number:content`.\n" +
    "- Respects .gitignore by default — won't search node_modules or other ignored paths.\n" +
    "- Use `ignore_case: true` for case-insensitive matching.\n\n" +
    "When to use:\n" +
    "- Finding where a function, variable, or symbol is defined or used.\n" +
    "- Searching for error messages, TODOs, or specific code patterns.\n" +
    "- Locating imports, exports, or configuration values.\n\n" +
    "When NOT to use:\n" +
    "- Finding files by name/pattern (use glob instead).\n" +
    "- Reading a known file (use file_read instead).",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      regex: {
        type: "string",
        minLength: 1,
        maxLength: 4096,
        description: "Regular expression pattern to search for",
      },
      search_path: {
        type: "string",
        minLength: 1,
        maxLength: 4096,
        description: "File or directory to search in. Defaults to current working directory.",
      },
      glob: {
        type: "string",
        minLength: 1,
        maxLength: 4096,
        description: "Restrict search to files matching this glob (e.g. '*.ts', '**/*.py')",
      },
      ignore_case: {
        type: "boolean",
        description: "If true, perform a case-insensitive search",
      },
      max_results: {
        type: "integer",
        minimum: 1,
        maximum: 1000,
        description: "Maximum number of matching lines to return. Default: 50",
      },
    },
    required: ["regex"],
  },
  execute: async (params, context): Promise<ToolResult> => {
    const regex = params.regex as string;
    if (!regex) {
      return {
        content: [{ type: "text", text: "Error: regex is required" }],
        isError: true,
      };
    }

    const searchPath = params.search_path
      ? path.resolve(context.cwd, params.search_path as string)
      : context.cwd;

    const maxResults = (params.max_results as number) || DEFAULT_MAX_RESULTS;

    const args: string[] = [
      regex,
      searchPath,
      "--line-number",
      "--no-heading",
      "--color=never",
      `--max-count=${maxResults}`,
    ];

    if (params.glob) {
      args.push(`--glob=${params.glob as string}`);
    }

    if (params.ignore_case) {
      args.push("-i");
    }

    try {
      const { stdout, stderr, stdoutTruncated, exitCode, signal } = await runHostProcess({
        command: "rg",
        args,
        cwd: context.cwd,
        signal: context.signal,
        maxOutputBytes: MAX_OUTPUT_BYTES,
      });

      // rg exit code 1 means no matches (not an error)
      if (exitCode === 1 && !stderr) {
        return {
          content: [{ type: "text", text: "No matches found." }],
          isError: false,
        };
      }

      if (signal || (exitCode !== 0 && exitCode !== 1)) {
        const detail = stderr.trim() || `ripgrep exited with ${signal ?? `code ${exitCode}`}`;
        return {
          content: [{ type: "text", text: `ripgrep error: ${detail}` }],
          isError: true,
        };
      }

      const output = stdout.trimEnd() + (stdoutTruncated ? "\n... (output truncated)" : "");
      return {
        content: [{ type: "text", text: output || "No matches found." }],
        isError: false,
      };
    } catch (err: unknown) {
      if (isAbortError(err, context.signal)) throw createAbortError(context.signal);
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return {
          content: [
            {
              type: "text",
              text:
                "Error: ripgrep (rg) is not installed or not in PATH. " +
                "Please install it: https://github.com/BurntSushi/ripgrep#installation",
            },
          ],
          isError: true,
        };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error running grep: ${msg}` }],
        isError: true,
      };
    }
  },
};
