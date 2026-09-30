export class TextReadError extends Error {
  constructor(
    readonly code: "invalid_pagination" | "file_changed" | "unsupported_file" | "read_failed",
    message: string,
    readonly retryable: boolean,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "TextReadError";
  }
}
