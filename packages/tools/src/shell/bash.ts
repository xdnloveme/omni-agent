import {
  createAbortError,
  isAbortError,
  type AgentToolDefinition,
  type ToolResult,
} from "@omni-agent/core";
import { runHostProcess } from "../process/host-process-runner";
import { assessBashPermission } from "./permission/bash-assessor";

const MAX_OUTPUT_BYTES = 10_240;

export const bashTool: AgentToolDefinition = {
  name: "bash",
  strict: true,
  timeout: {
    kind: "input",
    parameter: "timeout_ms",
    defaultMs: 120_000,
    minMs: 1_000,
    maxMs: 600_000,
  },
  authorization: { kind: "dynamic", assess: assessBashPermission },
  execution: { kind: "sandbox_eligible", profile: "shell" },
  description:
    "Execute a shell command and return its output (stdout/stderr).\n\n" +
    "Usage:\n" +
    "- Use for running shell commands: git operations, package management (npm/pnpm), " +
    "running tests, building projects, installing dependencies, and other CLI tasks.\n" +
    "- Commands default to a 120-second timeout; set `timeout_ms` for longer or shorter work.\n" +
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
    additionalProperties: false,
    properties: {
      command: {
        type: "string",
        minLength: 1,
        maxLength: 32_768,
        description: "The shell command to execute",
      },
      timeout_ms: {
        type: "integer",
        minimum: 1_000,
        maximum: 600_000,
        description: "Execution timeout in milliseconds. Defaults to 120000.",
      },
    },
    required: ["command"],
  },
  execute: async (params, context): Promise<ToolResult> => {
    const command = params.command as string;
    if (!command) {
      return {
        content: [{ type: "text", text: "Error: command is required" }],
        isError: true,
      };
    }

    try {
      const { stdout, stderr, stdoutTruncated, stderrTruncated, exitCode, signal } =
        await runHostProcess({
          command: "bash",
          args: ["-c", command],
          cwd: context.cwd,
          env: process.env,
          signal: context.signal,
          maxOutputBytes: MAX_OUTPUT_BYTES,
        });
      const parts: string[] = [];
      if (stdout) parts.push(stdout + (stdoutTruncated ? "\n... (stdout truncated)" : ""));
      if (stderr)
        parts.push(`STDERR:\n${stderr}${stderrTruncated ? "\n... (stderr truncated)" : ""}`);
      if (exitCode !== null && exitCode !== 0) {
        parts.push(`Exit code: ${exitCode}`);
      }
      if (signal) parts.push(`Terminated by signal: ${signal}`);

      const output = parts.length > 0 ? parts.join("\n") : "(no output)";

      return {
        content: [{ type: "text", text: output }],
        isError: signal !== null || (exitCode !== 0 && exitCode !== null),
      };
    } catch (err) {
      if (isAbortError(err, context.signal)) throw createAbortError(context.signal);
      return {
        content: [
          {
            type: "text",
            text: `Failed to execute command: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
};
