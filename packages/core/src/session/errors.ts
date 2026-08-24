export class AgentSessionNotFoundError extends Error {
  readonly code = "agent_session_not_found";

  constructor(readonly sessionId: string) {
    super(`Session not found: ${sessionId}`);
    this.name = "AgentSessionNotFoundError";
  }
}
