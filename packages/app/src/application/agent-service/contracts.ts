import type { AgentPackageDescriptor } from "../../agent-packages/contracts";

export type AgentServiceState = "ready" | "disposing" | "disposed";

export type AgentServiceAgent = AgentPackageDescriptor;

export interface AgentServiceSession {
  readonly agentId: string;
  readonly sessionId: string;
}

export interface AgentServiceRunRequest {
  readonly requestId: string;
  readonly agentId: string;
  readonly sessionId: string;
  readonly input: {
    readonly type: "text";
    readonly text: string;
  };
}

export interface AgentServiceFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export type AgentServiceEvent =
  | { readonly type: "started"; readonly requestId: string; readonly sessionId: string }
  | { readonly type: "text_delta"; readonly text: string }
  | { readonly type: "final_response"; readonly text: string }
  | { readonly type: "completed" }
  | ({ readonly type: "failed" } & AgentServiceFailure)
  | { readonly type: "cancelled" };

export interface AgentServicePort {
  listAgents(): Promise<readonly AgentServiceAgent[]>;
  openSession(input: {
    readonly agentId: string;
    readonly sessionId?: string;
  }): Promise<AgentServiceSession>;
  createSession(input: { readonly agentId: string }): Promise<AgentServiceSession>;
  closeSession(input: { readonly agentId: string; readonly sessionId: string }): Promise<void>;
  /**
   * Returns a lazy, single-consumer stream. The request is submitted on first iteration, and
   * returning from the iterator cancels queued or active work.
   */
  run(request: AgentServiceRunRequest, signal?: AbortSignal): AsyncIterable<AgentServiceEvent>;
  dispose(): Promise<void>;
}

export type AgentServiceErrorCode =
  | "agent_not_available"
  | "session_not_found"
  | "session_not_open"
  | "session_opening"
  | "session_closing"
  | "duplicate_request"
  | "event_stream_already_consumed"
  | "agent_service_closed";

export class AgentServiceError extends Error {
  constructor(
    readonly code: AgentServiceErrorCode,
    message: string,
    readonly retryable = false,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AgentServiceError";
  }
}

export interface AgentServiceResourceDisposalFailure {
  readonly resource: string;
  readonly error: unknown;
}

export class AgentServiceDisposalError extends AggregateError {
  readonly code = "agent_service_disposal_failed";

  constructor(readonly failures: readonly AgentServiceResourceDisposalFailure[]) {
    super(
      failures.map(({ error }) => error),
      "Failed to dispose Agent service resources",
    );
    this.name = "AgentServiceDisposalError";
  }
}
