import type { AgentServiceEvent, AgentServicePort, AgentServiceSession } from "@omni-agent/app";

export type HeadlessOutcome =
  | { readonly status: "completed" | "cancelled" }
  | { readonly status: "failed"; readonly code: string; readonly message: string };

export interface HeadlessRunOptions {
  readonly service: AgentServicePort;
  readonly agentId: string;
  readonly requestId: string;
  readonly input: string;
  readonly signal: AbortSignal;
  readonly onSession: (session: AgentServiceSession) => Promise<void>;
  readonly onLifecycle?: (phase: "session.close.started" | "session.close.completed") => void;
  readonly onEvent: (event: AgentServiceEvent) => void;
}

/** Owns one new Session and one Run; the process owner disposes the shared Service. */
export async function runHeadless(options: HeadlessRunOptions): Promise<HeadlessOutcome> {
  if (!options.input.trim()) throw new Error("Headless input must not be empty");
  if (options.signal.aborted) return { status: "cancelled" };
  const session = await options.service.createSession({ agentId: options.agentId });
  try {
    await options.onSession(session);
    let outcome: HeadlessOutcome | undefined;
    for await (const event of options.service.run(
      {
        ...session,
        requestId: options.requestId,
        input: { type: "text", text: options.input },
      },
      options.signal,
    )) {
      options.onEvent(event);
      if (event.type === "completed" || event.type === "cancelled")
        outcome = { status: event.type };
      if (event.type === "failed")
        outcome = { status: "failed", code: event.code, message: event.message };
    }
    if (!outcome) throw new Error("Agent Service stream ended without a terminal event");
    return outcome;
  } finally {
    options.onLifecycle?.("session.close.started");
    await options.service.closeSession(session);
    options.onLifecycle?.("session.close.completed");
  }
}
