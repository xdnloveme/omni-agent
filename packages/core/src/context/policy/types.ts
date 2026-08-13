import { cloneData } from "../../dataCopy";
import type { TranscriptMessage } from "../../messages";
import type { DeepReadonly } from "../../data";
import type { ContextFrame } from "../contracts/types";

export function createContextFrame(input: {
  readonly systemPrompt: string;
  readonly messages: readonly TranscriptMessage[];
  readonly tools: ContextFrame["tools"];
  readonly model: ContextFrame["model"];
}): ContextFrame {
  return {
    entries: input.messages.map((message, sourceIndex) => ({
      kind: "transcript" as const,
      sourceIndex,
      message: cloneData(message),
    })),
    systemPrompt: input.systemPrompt,
    tools: cloneData(input.tools),
    model: { ...input.model },
  };
}

export function cloneContextFrame(frame: DeepReadonly<ContextFrame>): ContextFrame {
  return cloneData(frame) as ContextFrame;
}

export function cloneContextDecisions<T>(decisions: T): T {
  return cloneData(decisions);
}
