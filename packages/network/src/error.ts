export class NetworkPolicyError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "NetworkPolicyError";
  }
}
