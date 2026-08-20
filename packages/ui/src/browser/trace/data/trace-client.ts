import type {
  TracePayload,
  TraceReplayRecord,
  TraceRun,
  TraceSession,
  TraceSpan,
} from "../model/contracts.js";

export interface AgentSummary {
  readonly agentId: string;
  readonly diskUsage: number;
}

export interface ReplayPage {
  readonly entries: readonly { readonly value: TraceReplayRecord }[];
  readonly cursor: number;
}

export interface SpanSnapshot {
  readonly spans: TraceSpan[];
  readonly cursor: number;
}

export async function requestJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal });
  if (!response.ok) {
    const failure = (await response.json()) as { readonly error?: string };
    throw new Error(failure.error || response.statusText);
  }
  return (await response.json()) as T;
}

export const traceClient = {
  agent: (signal?: AbortSignal) => requestJson<AgentSummary>("/api/agent", signal),
  sessions: (signal?: AbortSignal) => requestJson<TraceSession[]>("/api/sessions", signal),
  runs: (sessionId: string, signal?: AbortSignal) =>
    requestJson<TraceRun[]>(`/api/sessions/${sessionId}/runs`, signal),
  replay: (sessionId: string, runId: string, signal?: AbortSignal) =>
    requestJson<ReplayPage>(`/api/runs/${runId}/replay?sessionId=${sessionId}&limit=1000`, signal),
  spans: (sessionId: string, runId: string, signal?: AbortSignal) =>
    requestJson<SpanSnapshot>(`/api/runs/${runId}/spans?sessionId=${sessionId}`, signal),
  payload: (
    sessionId: string,
    runId: string,
    reference: { readonly payloadId: string; readonly parts: number },
    signal?: AbortSignal,
  ) =>
    requestJson<TracePayload>(
      `/api/runs/${runId}/payloads/${reference.payloadId}?sessionId=${sessionId}&parts=${reference.parts}`,
      signal,
    ),
};
