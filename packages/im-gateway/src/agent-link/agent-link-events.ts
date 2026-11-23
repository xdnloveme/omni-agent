interface AgentServiceFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export type AgentLinkEvent =
  | { readonly type: "started"; readonly requestId: string; readonly sessionId: string }
  | { readonly type: "text_delta"; readonly text: string }
  | { readonly type: "final_response"; readonly text: string }
  | { readonly type: "completed" }
  | ({ readonly type: "failed" } & AgentServiceFailure)
  | { readonly type: "cancelled" }
  | { readonly type: "unknown"; readonly message: string };

export function isAgentLinkTerminal(event: AgentLinkEvent): boolean {
  return ["completed", "failed", "cancelled", "unknown"].includes(event.type);
}
