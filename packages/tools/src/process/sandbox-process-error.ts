export class SandboxProcessError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SandboxProcessError";
  }
}
