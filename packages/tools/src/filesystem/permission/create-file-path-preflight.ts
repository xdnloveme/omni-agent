import type { ToolPreflightDescriptor } from "@omni-agent/core";
import { FileToolError, fileToolErrorResult } from "../io/file-errors";
import { inspectPathPreflight } from "../../security/path/path-preflight";
import type { PathTargetKind } from "../../security/path/inspect-path-security";

export function createFilePathPreflight(options: {
  parameter: string;
  acceptedKinds: readonly PathTargetKind[];
  operation: string;
}): ToolPreflightDescriptor {
  return {
    async validate(input, context) {
      const result = await inspectPathPreflight(input[options.parameter], context.cwd, options);
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
