import {
  createAbortError,
  isAbortError,
  type AgentToolDefinition,
  type ToolResult,
} from "@omni-agent/core";
import { runHostProcess } from "../process/host-process-runner";
import { assessBashPermission } from "./permission/bash-assessor";
import { createShellEnvironment } from "./shell-environment";

const DEFAULT_TIMEOUT_MS = 120_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_BYTES = 10 * 1024;

export const bashTool: AgentToolDefinition = {
  name: "bash",
  strict: true,
  timeout: {
    kind: "input",
    parameter: "timeout_ms",
    defaultMs: DEFAULT_TIMEOUT_MS,
    minMs: MIN_TIMEOUT_MS,
    maxMs: MAX_TIMEOUT_MS,
  },
  authorization: { kind: "dynamic", assess: assessBashPermission },
  execution: { kind: "sandbox_eligible", profile: "shell" },
  description:
    "Execute Bash source from the current workspace and return its stdout/stderr.\n\n" +
    "Usage:\n" +
    "- Use for running shell commands: git operations, package management (npm/pnpm), " +
    "running tests, building projects, installing dependencies, and other CLI tasks.\n" +
    `- Commands default to a ${DEFAULT_TIMEOUT_MS / 1_000}-second timeout; set \`timeout_ms\` for longer or shorter work.\n` +
    `- Combined output is limited to ${MAX_OUTPUT_BYTES / 1024} KiB. For verbose commands, narrow the output or redirect it to a workspace file and read the needed range.\n\n` +
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
        description: "Bash source to execute from the current workspace directory.",
      },
      timeout_ms: {
        type: "integer",
        minimum: MIN_TIMEOUT_MS,
        maximum: MAX_TIMEOUT_MS,
        description: `Execution budget in milliseconds, excluding permission wait time. Defaults to ${DEFAULT_TIMEOUT_MS}.`,
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
          env: createShellEnvironment(process.env),
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
