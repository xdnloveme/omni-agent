import type { AgentFailure } from "../../types";

export function maxTurnsFailure(maxTurns: number): AgentFailure {
  return {
    code: "max_turns_reached",
    message: `Max turns reached (${maxTurns})`,
    retryable: false,
  };
}

export function runtimeFailure(code: string, error: unknown, retryable: boolean): AgentFailure {
  return {
    code,
    message: error instanceof Error ? error.message : String(error),
    retryable,
  };
}
