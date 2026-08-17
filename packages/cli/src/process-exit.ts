import type { TuiTermination } from "./interaction/tui/tui";

export function exitCodeForTermination(termination: TuiTermination): number {
  switch (termination.kind) {
    case "completed":
      return 0;
    case "user_interrupt":
      return 130;
    case "signal":
      return termination.signal === "SIGTERM" ? 143 : 1;
  }
}
