import { cloneData } from "../../dataCopy";
import type { RuntimeModelRequestCapturedFact } from "../../runtime-observation";
import type { ReplayEventInput } from "../types";

export function modelRequestReplayInput(fact: RuntimeModelRequestCapturedFact): ReplayEventInput {
  return {
    kind: "model.request.captured",
    correlation: { modelCallId: fact.context.manifest.modelCallId },
    payload: cloneData({
      systemPrompt: fact.context.systemPrompt,
      messages: fact.context.messages,
      tools: fact.context.tools,
      manifest: fact.context.manifest,
      snapshotId: fact.context.snapshotId,
      selection: fact.selection,
      ...(fact.recovery ? { recovery: fact.recovery } : {}),
    }),
  };
}
