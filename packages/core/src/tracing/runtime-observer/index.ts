import type {
  RuntimeObservationDiagnosticSink,
  RuntimeObserverPort,
} from "../../runtime-observation";
import type { ReplaySinkPort, TracerPort } from "../ports";
import { SpanRuntimeObserver } from "./span-runtime-observer";
import { ReplayRuntimeObserver } from "./replay-runtime-observer";

export function createRuntimeTraceObservers(
  tracer: TracerPort,
  replay: ReplaySinkPort,
  diagnostic?: RuntimeObservationDiagnosticSink,
): readonly RuntimeObserverPort[] {
  return [
    new SpanRuntimeObserver(tracer, diagnostic),
    new ReplayRuntimeObserver(replay, diagnostic),
  ];
}
