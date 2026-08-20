import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { traceClient } from "../data/trace-client.js";
import type { NodeDetails, TraceReplayRecord } from "../model/contracts.js";

export function usePayloadHydration({
  sessionId,
  runId,
  details,
  replay,
  setReplay,
}: {
  readonly sessionId: string | null;
  readonly runId: string | null;
  readonly details: NodeDetails | null;
  readonly replay: readonly TraceReplayRecord[];
  readonly setReplay: Dispatch<SetStateAction<TraceReplayRecord[]>>;
}): void {
  const requests = useRef(new Map<string, AbortController>());

  useEffect(() => {
    const active = requests.current;
    return () => {
      for (const controller of active.values()) controller.abort();
      active.clear();
    };
  }, [sessionId, runId]);

  useEffect(() => {
    if (!details || !sessionId || !runId) return;
    const relatedSequences = new Set(details.replayEvents.map((event) => event.seq));
    for (const record of replay) {
      const reference = record.payloadRef;
      if (
        !relatedSequences.has(record.seq) ||
        !reference?.payloadId ||
        !reference.parts ||
        record.resolvedPayload
      ) {
        continue;
      }
      const requestId = `${sessionId}:${runId}:${record.seq}`;
      if (requests.current.has(requestId)) continue;
      const payloadReference = { payloadId: reference.payloadId, parts: reference.parts };
      const controller = new AbortController();
      requests.current.set(requestId, controller);
      void traceClient
        .payload(sessionId, runId, payloadReference, controller.signal)
        .then((payload) => {
          if (controller.signal.aborted) return;
          setReplay((current) =>
            current.map((entry) =>
              entry.seq === record.seq ? { ...entry, resolvedPayload: payload } : entry,
            ),
          );
        })
        .catch(() => undefined)
        .finally(() => requests.current.delete(requestId));
    }
  }, [details, replay, runId, sessionId, setReplay]);
}
