import type { ToolResult } from "@omni-agent/core";

export type FileToolErrorCode =
  | "invalid_pagination"
  | "file_changed"
  | "unsupported_file"
  | "file_too_large"
  | "match_not_found"
  | "match_not_unique"
  | "no_change"
  | "read_failed"
  | "write_failed";

export class FileToolError extends Error {
  constructor(
    readonly code: FileToolErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "FileToolError";
  }
}

export function fileToolErrorResult(error: FileToolError): ToolResult {
  return {
    content: [{ type: "text", text: error.message }],
    isError: true,
    meta: { code: error.code, retryable: error.retryable, ...error.details },
  };
}
