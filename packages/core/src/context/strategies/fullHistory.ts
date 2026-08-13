import { throwIfAborted } from "../../execution";
import type { DeepReadonly } from "../../data";
import { cloneTranscriptMessages } from "../../messages";
import type { ContextStrategyPort } from "../contracts/ports";
import type {
  ContextDraft,
  ContextStrategyOptions,
  ContextStrategyResult,
} from "../contracts/types";

export class FullHistoryContextStrategy implements ContextStrategyPort {
  readonly name = "full_history";
  readonly version = 1;

  async apply(
    draft: DeepReadonly<ContextDraft>,
    options: ContextStrategyOptions,
  ): Promise<ContextStrategyResult> {
    throwIfAborted(options.signal);
    return {
      messages: cloneTranscriptMessages(draft.messages),
      decisions: [{ type: "preserve_all" }],
    };
  }
}
