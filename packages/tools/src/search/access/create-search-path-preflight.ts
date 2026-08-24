import type { ToolPreflightDescriptor, ToolResult } from "@omni-agent/core";
import type { PathTargetKind } from "../../security/path/inspect-path-security";
import { inspectPathPreflight } from "../../security/path/path-preflight";

export function createSearchPathPreflight(options: {
  parameter: string;
  defaultToCwd?: boolean;
  acceptedKinds: readonly PathTargetKind[];
}): ToolPreflightDescriptor {
  return {
    async validate(input, context) {
      const value = input[options.parameter] ?? (options.defaultToCwd ? context.cwd : undefined);
      const result = await inspectPathPreflight(value, context.cwd, context.hostRuntime, {
        acceptedKinds: options.acceptedKinds,
        operation: "search",
      });
      return result.outcome === "ready"
        ? { outcome: "ready" }
        : { outcome: "error", result: searchError(result.issue) };
    },
  };
}

function searchError(issue: { code: string; message: string; retryable: boolean }): ToolResult {
  return {
    content: [{ type: "text", text: issue.message }],
    isError: true,
    meta: { code: issue.code, retryable: issue.retryable },
  };
}
