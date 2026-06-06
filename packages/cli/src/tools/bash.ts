import { spawn } from "node:child_process";
import type { AgentTool, ToolResult } from "@omni-agent/core";

const TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 10_240;

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + `\n... (truncated, ${text.length} total chars)`;
}

async function executeBash(
  command: string,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("bash", ["-c", command], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      proc.kill("SIGKILL");
    }, TIMEOUT_MS);

    // Handle abort signal
    const onAbort = () => {
      killed = true;
      proc.kill("SIGKILL");
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(err);
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (killed && !signal?.aborted) {
        resolve({ stdout, stderr: stderr + "\n(process killed: timeout)", exitCode: null });
      } else {
        resolve({ stdout, stderr, exitCode: code });
      }
    });
  });
}

export const bashTool: AgentTool = {
  name: "bash",
  description:
    "Execute a shell command and return its output (stdout/stderr).\n\n" +
    "Usage:\n" +
    "- Use for running shell commands: git operations, package management (npm/pnpm), " +
    "running tests, building projects, installing dependencies, and other CLI tasks.\n" +
    "- Commands run in bash with a 30-second timeout.\n" +
    "- Output is truncated to 10KB — for verbose commands, pipe through `tail` or redirect to a file.\n\n" +
    "When to use:\n" +
    "- Running tests (`pnpm test`, `pytest`, etc.).\n" +
    "- Git operations (`git status`, `git diff`, `git commit`).\n" +
    "- Installing packages (`pnpm add`, `npm install`).\n" +
    "- Building or compiling projects.\n" +
    "- Any CLI tool not covered by other specialized tools.\n\n" +
    "When NOT to use:\n" +
    "- File search/discovery (use glob instead of `find` or `ls`).\n" +
    "- Content search (use grep instead of `grep`, `rg`, or `awk`).\n" +
    "- Reading files (use file_read instead of `cat`, `head`, or `tail`).\n" +
    "- Editing files (use file_edit instead of `sed` or `awk`).",
  schema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The shell command to execute",
      },
    },
    required: ["command"],
  },
  execute: async (params: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> => {
    const command = params.command as string;
    if (!command) {
      return {
        content: [{ type: "text", text: "Error: command is required" }],
        isError: true,
      };
    }

    try {
      const { stdout, stderr, exitCode } = await executeBash(command, signal);
      const parts: string[] = [];
      if (stdout) parts.push(truncate(stdout, MAX_OUTPUT_BYTES));
      if (stderr) parts.push(`STDERR:\n${truncate(stderr, MAX_OUTPUT_BYTES)}`);
      if (exitCode !== null && exitCode !== 0) {
        parts.push(`Exit code: ${exitCode}`);
      }

      const output = parts.length > 0 ? parts.join("\n") : "(no output)";

      return {
        content: [{ type: "text", text: output }],
        isError: exitCode !== 0 && exitCode !== null,
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Failed to execute command: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
};
