import type { ToolPreflightDescriptor } from "@omni-agent/core";
import type { PathTargetKind } from "../../security/path/inspect-path-security";
import { inspectPathPreflight } from "../../security/path/path-preflight";
import { FileToolError, fileToolErrorResult } from "../io/file-errors";

export function createFilePathPreflight(options: {
  parameter: string;
  acceptedKinds: readonly PathTargetKind[];
  operation: string;
}): ToolPreflightDescriptor {
  return {
    async validate(input, context) {
      const result = await inspectPathPreflight(
        input[options.parameter],
        context.cwd,
        context.hostRuntime,
        options,
      );
      if (result.outcome === "ready") return { outcome: "ready" };
      const code = result.issue.code === "path_not_found" ? "read_failed" : "unsupported_file";
      return {
        outcome: "error",
        result: fileToolErrorResult(
          new FileToolError(code, result.issue.message, result.issue.retryable),
        ),
      };
    },
  };
}
