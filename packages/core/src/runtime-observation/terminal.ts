import {
  reportRuntimeObservationDiagnostic,
  type RuntimeObservationDiagnosticSink,
} from "./diagnostics";

export class RuntimeObservationTerminal {
  private open = true;

  constructor(
    private readonly scope: string,
    private readonly diagnostic?: RuntimeObservationDiagnosticSink,
  ) {}

  finish(terminal: string, operation: () => void): void {
    if (!this.open) {
      reportRuntimeObservationDiagnostic(
        this.diagnostic,
        `${this.scope}.${terminal}`,
        new Error(`Runtime observation scope is already terminal: ${this.scope}`),
      );
      return;
    }
    this.open = false;
    try {
      operation();
    } catch (error) {
      reportRuntimeObservationDiagnostic(this.diagnostic, `${this.scope}.${terminal}`, error);
    }
  }

  allows(operation: string): boolean {
    if (this.open) return true;
    reportRuntimeObservationDiagnostic(
      this.diagnostic,
      `${this.scope}.${operation}`,
      new Error(`Runtime observation scope is already terminal: ${this.scope}`),
    );
    return false;
  }
}
