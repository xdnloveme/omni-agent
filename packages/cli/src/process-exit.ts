import type { HostTermination } from "./host-services";

export function exitCodeForTermination(termination: HostTermination): number {
  switch (termination.kind) {
    case "completed":
      return 0;
    case "user_interrupt":
      return 130;
    case "signal":
      return termination.signal === "SIGTERM" ? 143 : 1;
  }
}
