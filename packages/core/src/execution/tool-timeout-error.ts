export class ToolTimeoutError extends Error {
  readonly code = "tool_timeout";

  constructor(readonly timeoutMs: number) {
    super(`Tool timed out after ${timeoutMs}ms`);
    this.name = "ToolTimeoutError";
  }
}
