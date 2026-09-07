import type { AgentToolDefinition, ProcessResult, ToolResult } from "@omni-agent/core";
import { analyzeShellAccess } from "./access/analyze-shell-access";
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
  access: { kind: "dynamic", assess: analyzeShellAccess },
  execution: { kind: "process" },
  invocation: { action: "execute", resource: { kind: "command", inputKey: "command" } },
  description:
    "Execute Bash source from the current execution directory and return its stdout/stderr.\n\n" +
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
        description: "Bash source to execute from the current execution directory.",
      },
      timeout_ms: {
        type: "integer",
        minimum: MIN_TIMEOUT_MS,
        maximum: MAX_TIMEOUT_MS,
        description: `Execution budget in milliseconds, excluding access evaluation and network consent time. Defaults to ${DEFAULT_TIMEOUT_MS}.`,
      },
      sandbox_scope: {
        type: "object",
        additionalProperties: false,
        description:
          "Declares network and external filesystem access needs. In controlled mode, missing path scopes may be offered to the user as persistent workspace access; in autonomous mode they apply only to this call; unrestricted mode does not use them.",
        properties: {
          network_targets: {
            type: "array",
            maxItems: 32,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                scheme: { type: "string", enum: ["http", "https"] },
                host: { type: "string", minLength: 1, maxLength: 253 },
                port: { type: "integer", minimum: 1, maximum: 65_535 },
              },
              required: ["scheme", "host", "port"],
            },
          },
          read_paths: { type: "array", maxItems: 32, items: pathScopeSchema() },
          write_paths: { type: "array", maxItems: 32, items: pathScopeSchema() },
        },
      },
    },
    required: ["command"],
  },
  createProcessInvocation(params, context) {
    return {
      command: "/bin/bash",
      args: ["-c", params.command as string],
      cwd: context.cwd,
      env: createShellEnvironment(process.env),
      maxOutputBytes: MAX_OUTPUT_BYTES,
    };
  },
  createToolResult: (result): ToolResult => {
    const parts: string[] = [];
    if (result.stdout) {
      parts.push(result.stdout + (result.stdoutTruncated ? "\n... (stdout truncated)" : ""));
    }
    if (result.stderr) {
      parts.push(
        `STDERR:\n${result.stderr}${result.stderrTruncated ? "\n... (stderr truncated)" : ""}`,
      );
    }
    if (result.exitCode !== null && result.exitCode !== 0)
      parts.push(`Exit code: ${result.exitCode}`);
    if (result.signal) parts.push(`Terminated by signal: ${result.signal}`);
    return {
      content: [{ type: "text", text: parts.length > 0 ? parts.join("\n") : "(no output)" }],
      isError: result.signal !== null || (result.exitCode !== 0 && result.exitCode !== null),
    };
  },
};

function pathScopeSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      path: { type: "string", minLength: 1, maxLength: 4096 },
      scope: { type: "string", enum: ["exact", "subtree"] },
    },
    required: ["path", "scope"],
  };
}
