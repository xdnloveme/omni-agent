import { spawn } from "node:child_process";
import path from "node:path";
import type { AgentTool, ToolResult } from "@omni-agent/core";

const DEFAULT_MAX_RESULTS = 50;
const MAX_OUTPUT_BYTES = 51_200; // 50KB

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "\n... (output truncated)";
}

async function runRipgrep(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("rg", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("error", (err) => {
      reject(err);
    });

    proc.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code });
    });
  });
}

export const grepTool: AgentTool = {
  name: "grep",
  risk: "read",
  approval: "never",
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
    properties: {
      regex: {
        type: "string",
        description: "Regular expression pattern to search for",
      },
      search_path: {
        type: "string",
        description: "File or directory to search in. Defaults to current working directory.",
      },
      glob: {
        type: "string",
        description: "Restrict search to files matching this glob (e.g. '*.ts', '**/*.py')",
      },
      ignore_case: {
        type: "boolean",
        description: "If true, perform a case-insensitive search",
      },
      max_results: {
        type: "number",
        description: "Maximum number of matching lines to return. Default: 50",
      },
    },
    required: ["regex"],
  },
  execute: async (params: Record<string, unknown>): Promise<ToolResult> => {
    const regex = params.regex as string;
    if (!regex) {
      return {
        content: [{ type: "text", text: "Error: regex is required" }],
        isError: true,
      };
    }

    const searchPath = params.search_path
      ? path.resolve(params.search_path as string)
      : process.cwd();

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
      const { stdout, stderr, exitCode } = await runRipgrep(args, searchPath);

      // rg exit code 1 means no matches (not an error)
      if (exitCode === 1 && !stderr) {
        return {
          content: [{ type: "text", text: "No matches found." }],
          isError: false,
        };
      }

      if (exitCode !== 0 && exitCode !== 1 && stderr) {
        return {
          content: [{ type: "text", text: `ripgrep error: ${stderr.trim()}` }],
          isError: true,
        };
      }

      const output = truncate(stdout.trimEnd(), MAX_OUTPUT_BYTES);
      return {
        content: [{ type: "text", text: output || "No matches found." }],
        isError: false,
      };
    } catch (err: unknown) {
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
