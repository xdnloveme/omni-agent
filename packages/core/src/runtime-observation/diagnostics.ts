export interface RuntimeObservationDiagnostic {
  readonly operation: string;
  readonly message: string;
}

export type RuntimeObservationDiagnosticSink = (diagnostic: RuntimeObservationDiagnostic) => void;

export function reportRuntimeObservationDiagnostic(
  sink: RuntimeObservationDiagnosticSink | undefined,
  operation: string,
  error: unknown,
): void {
  if (!sink) return;
  try {
    sink({
      operation,
      message: error instanceof Error ? error.message : String(error),
    });
  } catch {}
}
