import type { RunDeadlineSnapshot } from "../execution/run-deadline";

export function renderRunDeadline(snapshot: RunDeadlineSnapshot): string {
  return `<run_context>\nRuntime facts for this request, not a user task. Remaining time is a snapshot at capturedAtMs, not a renewed allowance.\n${JSON.stringify(snapshot)}\n</run_context>`;
}
