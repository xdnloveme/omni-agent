import type { AgentToolDefinition, ProcessResult, ToolResult } from "@omni-agent/core";
import { analyzeShellAccess } from "./access/analyze-shell-access";
import { createShellEnvironment } from "./shell-environment";

const DEFAULT_TIMEOUT_MS = 120_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_BYTES = 10 * 1024;

export const bashTool: AgentToolDefinition = {
  name: "bash",
  inputConstraint: "prefer",
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
    "The exit status describes the entire shell, not business success. Pipelines normally return the last command status. Use explicit `set -o pipefail` or capture and return a command exit status when upstream failures must propagate.\n\n" +
    "Usage:\n" +
    "- Use for running shell commands: git operations, package management (npm/pnpm), " +
    "running tests, building projects, installing dependencies, and other CLI tasks.\n" +
    `- Commands default to a ${DEFAULT_TIMEOUT_MS / 1_000}-second timeout; set \`timeout_ms\` for longer or shorter work.\n` +
    `- The combined stdout/stderr body preview is limited to ${MAX_OUTPUT_BYTES / 1024} KiB (or the Session preview budget, if smaller). Long output shows its beginning and end; each stream has reserved capacity. Status and saved-output references are separate.\n` +
    "- If you may need the full output later, avoid discarding it with filters such as head or tail: only output reaching this tool can be saved. When output retention is unavailable, redirect verbose output to a workspace file and read the needed range.\n\n" +
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
          "Declares network needs and filesystem read/write targets, including workspace targets. Declarations do not grant permission. In controlled mode, external path scopes may require user approval; in autonomous mode they apply only to this call. Unrestricted mode bypasses access restrictions, but declarations still describe potential read/write targets to the caller.",
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
          write_paths: {
            type: "array",
            maxItems: 32,
            description:
              "Bounded potential write targets. Use exact for a known file or subtree for an existing directory containing dynamic writes. An empty array does not establish that a command is read-only.",
            items: pathScopeSchema(),
          },
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
      maxOutputBytes: Math.min(MAX_OUTPUT_BYTES, context.outputs?.previewBytes ?? MAX_OUTPUT_BYTES),
      outputPreview: "head-tail",
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
    const streams: ("stdout" | "stderr")[] = [
      ...(result.stdout ? ["stdout" as const] : []),
      ...(result.stderr ? ["stderr" as const] : []),
    ];
    const content: ToolResult["content"] = parts.map((text, index) => {
      const partId = result.outputSource?.streams[streams[index]!];
      return {
        type: "text",
        text,
        ...(partId && result.outputSource
          ? { outputSource: { outputId: result.outputSource.outputId, partIds: [partId] } }
          : {}),
      };
    });
    const status = [
      ...(result.exitCode !== null ? [`Exit code: ${result.exitCode}`] : []),
      ...(result.signal ? [`Terminated by signal: ${result.signal}`] : []),
    ];
    if (status.length) content.push({ type: "text", text: status.join("\n") });

    return {
      content: content.length ? content : [{ type: "text", text: "(no output)" }],
      meta: {
        process: {
          exitCode: result.exitCode,
          signal: result.signal ?? null,
          stdoutTruncated: result.stdoutTruncated ?? false,
          stderrTruncated: result.stderrTruncated ?? false,
        },
      },
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
