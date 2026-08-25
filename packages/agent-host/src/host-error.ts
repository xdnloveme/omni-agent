import type { AgentServiceFailure } from "@omni-agent/app";

export type AgentHostErrorCode =
  | "invalid_message"
  | "unsupported_version"
  | "unauthorized"
  | "host_busy"
  | "duplicate_request"
  | "request_not_active"
  | "payload_too_large"
  | "host_closed";

export class AgentHostError extends Error {
  constructor(
    readonly code: AgentHostErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "AgentHostError";
  }
}

export function toAgentHostFailure(error: AgentHostError): AgentServiceFailure {
  return { code: error.code, message: error.message, retryable: error.retryable };
}
