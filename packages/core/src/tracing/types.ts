export type TraceScalar = string | number | boolean;
export type TraceAttributes = Readonly<Record<string, TraceScalar>>;
export type TraceStatus = "unset" | "ok" | "error" | "cancelled" | "denied" | "timed_out";
export type TraceTerminalState = "completed" | "error" | "cancelled" | "denied" | "timed_out";

export interface TraceRunIdentity {
  readonly agentId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly traceId: string;
}

export interface TraceSpanIdentity extends TraceRunIdentity {
  readonly spanId: string;
  readonly parentSpanId?: string;
}

export interface ReplayCorrelation {
  readonly traceId?: string;
  readonly spanId?: string;
  readonly modelCallId?: string;
  readonly batchId?: string;
  readonly toolCallId?: string;
}

export interface ReplayEventInput {
  readonly kind: string;
  readonly correlation?: ReplayCorrelation;
  readonly payload?: unknown;
  readonly hiddenKeys?: readonly string[];
}
