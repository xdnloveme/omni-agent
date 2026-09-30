import { cloneData } from "../../dataCopy";
import type { TranscriptMessage } from "../../messages";
import type { DeepReadonly } from "../../data";
import type { ContextEnvelope, ContextHistoryFrame } from "../contracts/types";
import type { EnvironmentContextRecord } from "../../environment";
import type { ModelToolSpec } from "../../models/runtime";
import type { ContextModelLimits } from "../contracts/types";

export function createContextEnvelope(input: {
  readonly systemPrompt: string;
  readonly messages: readonly TranscriptMessage[];
  readonly tools: readonly ModelToolSpec[];
  readonly model: ContextModelLimits;
  readonly environment?: EnvironmentContextRecord;
  readonly runDeadline?: import("../../execution/run-deadline").RunDeadlineSnapshot;
}): ContextEnvelope {
  return {
    fixed: {
      ...(input.runDeadline ? { runDeadline: { ...input.runDeadline } } : {}),
      systemPrompt: input.systemPrompt,
      tools: cloneData(input.tools),
      model: { ...input.model },
      ...(input.environment
        ? { environment: cloneData(input.environment) as EnvironmentContextRecord }
        : {}),
    },
    history: {
      entries: input.messages.map((message, sourceIndex) => ({
        kind: "transcript" as const,
        sourceIndex,
        message: cloneData(message),
      })),
    },
  };
}

export function cloneContextHistoryFrame(
  frame: DeepReadonly<ContextHistoryFrame>,
): ContextHistoryFrame {
  return cloneData(frame) as ContextHistoryFrame;
}

export function cloneContextEnvelope(envelope: DeepReadonly<ContextEnvelope>): ContextEnvelope {
  return cloneData(envelope) as ContextEnvelope;
}

export function cloneContextDecisions<T>(decisions: T): T {
  return cloneData(decisions);
}
