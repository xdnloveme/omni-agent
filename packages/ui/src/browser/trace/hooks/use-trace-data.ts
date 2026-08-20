import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { traceClient, type AgentSummary } from "../data/trace-client.js";
import type {
  SpanRecord,
  TraceReplayRecord,
  TraceRun,
  TraceSession,
  TraceSpan,
} from "../model/contracts.js";
import { selectedRun } from "../model/view-model.js";

export interface TraceDataState {
  readonly agent: AgentSummary | null;
  readonly sessions: readonly TraceSession[];
  readonly runs: readonly TraceRun[];
  readonly sessionId: string | null;
  readonly runId: string | null;
  readonly run: TraceRun | null;
  readonly replay: readonly TraceReplayRecord[];
  readonly spans: readonly TraceSpan[];
  readonly loading: boolean;
  readonly error: string | null;
  selectSession(sessionId: string | null): void;
  selectRun(runId: string | null): void;
  setReplay(replay: SetStateAction<TraceReplayRecord[]>): void;
}

export function useTraceData(): TraceDataState {
  const [agent, setAgent] = useState<AgentSummary | null>(null);
  const [sessions, setSessions] = useState<TraceSession[]>([]);
  const [runs, setRuns] = useState<TraceRun[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [replay, setReplayState] = useState<TraceReplayRecord[]>([]);
  const [spans, setSpans] = useState<TraceSpan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [discoveryRevision, setDiscoveryRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      traceClient.agent(controller.signal),
      traceClient.sessions(controller.signal),
    ])
      .then(([nextAgent, nextSessions]) => {
        setAgent(nextAgent);
        setSessions(nextSessions);
        setSessionId((current) =>
          current && nextSessions.some((session) => session.sessionId === current)
            ? current
            : (nextSessions[0]?.sessionId ?? null),
        );
        setError(null);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(publicMessage(failure));
      });
    return () => controller.abort();
  }, [discoveryRevision]);

  useEffect(() => {
    const source = new EventSource("/api/live");
    source.onmessage = () => setDiscoveryRevision((revision) => revision + 1);
    return () => source.close();
  }, []);

  useEffect(() => {
    if (!sessionId) {
      setRuns([]);
      setRunId(null);
      return;
    }
    const controller = new AbortController();
    void traceClient
      .runs(sessionId, controller.signal)
      .then((nextRuns) => {
        setRuns(nextRuns);
        setRunId((current) =>
          current && nextRuns.some((run) => run.runId === current)
            ? current
            : (nextRuns[0]?.runId ?? null),
        );
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(publicMessage(failure));
      });
    return () => controller.abort();
  }, [sessionId, discoveryRevision]);

  useEffect(() => {
    setReplayState([]);
    setSpans([]);
    if (!sessionId || !runId) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    let source: EventSource | null = null;
    setLoading(true);
    void Promise.all([
      traceClient.replay(sessionId, runId, controller.signal),
      traceClient.spans(sessionId, runId, controller.signal),
    ])
      .then(([replayPage, spanSnapshot]) => {
        if (controller.signal.aborted) return;
        setReplayState(replayPage.entries.map((entry) => entry.value));
        setSpans(spanSnapshot.spans);
        setLoading(false);
        setError(null);
        source = connectLiveRun(
          sessionId,
          runId,
          replayPage.cursor,
          spanSnapshot.cursor,
          setReplayState,
          setSpans,
        );
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) {
          setLoading(false);
          setError(publicMessage(failure));
        }
      });
    return () => {
      controller.abort();
      source?.close();
    };
  }, [sessionId, runId]);

  const selectSession = useCallback((next: string | null) => {
    setSessionId(next);
    setRunId(null);
  }, []);
  const setReplay = useCallback((next: SetStateAction<TraceReplayRecord[]>) => {
    setReplayState(next);
  }, []);
  const run = useMemo(() => selectedRun(runId, runs), [runId, runs]);

  return {
    agent,
    sessions,
    runs,
    sessionId,
    runId,
    run,
    replay,
    spans,
    loading,
    error,
    selectSession,
    selectRun: setRunId,
    setReplay,
  };
}

function connectLiveRun(
  sessionId: string,
  runId: string,
  replayCursor: number,
  spanCursor: number,
  setReplay: Dispatch<SetStateAction<TraceReplayRecord[]>>,
  setSpans: Dispatch<SetStateAction<TraceSpan[]>>,
): EventSource {
  let spanSequence = 0;
  const source = new EventSource(
    `/api/runs/${runId}/live?sessionId=${sessionId}&cursor=${replayCursor}&spanCursor=${spanCursor}`,
  );
  source.addEventListener("replay", (event) => {
    const record = JSON.parse(event.data) as TraceReplayRecord;
    setReplay((current) =>
      current.some((entry) => entry.seq === record.seq) ? current : [...current, record],
    );
  });
  source.addEventListener("span", (event) => {
    const update = JSON.parse(event.data) as { readonly record: SpanRecord };
    if (update.record.seq <= spanSequence) return;
    spanSequence = update.record.seq;
    setSpans((current) => applySpanRecord(current, update.record));
  });
  return source;
}

function applySpanRecord(spans: readonly TraceSpan[], record: SpanRecord): TraceSpan[] {
  if (record.kind === "span.started") {
    if (spans.some((span) => span.spanId === record.identity.spanId)) return [...spans];
    return [
      ...spans,
      {
        spanId: record.identity.spanId,
        ...(record.identity.parentSpanId ? { parentSpanId: record.identity.parentSpanId } : {}),
        name: record.name,
        startedAt: record.timestamp,
        status: "running",
        attributes: { ...record.attributes },
        events: [],
      },
    ];
  }
  return spans.map((span) => {
    if (span.spanId !== record.spanId) return span;
    if (record.kind === "span.updated") {
      return {
        ...span,
        attributes: { ...span.attributes, [record.attribute.key]: record.attribute.value },
      };
    }
    if (record.kind === "span.event") {
      return {
        ...span,
        events: [
          ...span.events,
          { timestamp: record.timestamp, name: record.name, attributes: record.attributes },
        ],
      };
    }
    return {
      ...span,
      completedAt: record.completedAt,
      status: record.status,
      ...(record.error ? { error: record.error } : {}),
    };
  });
}

function publicMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
