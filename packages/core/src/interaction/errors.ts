export type InteractionErrorCode =
  | "interaction_unavailable"
  | "interaction_busy"
  | "invalid_interaction_request"
  | "invalid_interaction_response";

export class InteractionError extends Error {
  constructor(
    readonly code: InteractionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "InteractionError";
  }
}

export type InteractionTermination = "abort" | "shutdown";

export class InteractionAbortError extends Error {
  readonly name = "AbortError";

  constructor(
    readonly termination: InteractionTermination,
    cause?: Error,
  ) {
    super(cause?.message ?? "The interaction was aborted", cause ? { cause } : undefined);
  }
}
