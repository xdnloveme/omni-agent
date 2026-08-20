import type { StreamCallbacks } from "@omni-agent/core";
import { NOOP_RUNTIME_RUN_OBSERVATION, type RuntimeRunObservation } from "@omni-agent/core/host";

export interface AgentRunObservationRequest {
  readonly sessionId: string;
  readonly input: string;
  readonly callbacks: StreamCallbacks;
  readonly signal?: AbortSignal;
}

export interface AgentRunObservationPort {
  observe(
    request: AgentRunObservationRequest,
    operation: (observation: RuntimeRunObservation, callbacks: StreamCallbacks) => Promise<void>,
  ): Promise<void>;
  dispose(): Promise<void>;
}

export const NOOP_AGENT_RUN_OBSERVATION: AgentRunObservationPort = {
  observe: (request, operation) => operation(NOOP_RUNTIME_RUN_OBSERVATION, request.callbacks),
  dispose: async () => undefined,
};
