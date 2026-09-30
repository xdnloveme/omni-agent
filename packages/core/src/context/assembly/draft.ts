import { cloneData } from "../../dataCopy";
import { cloneTranscriptMessages } from "../../messages";
import type { ModelToolSpec } from "../../models/runtime";
import type {
  ContextConversationSource,
  ContextDraft,
  ContextModelLimits,
} from "../contracts/types";

export function createContextDraft(input: {
  readonly source: ContextConversationSource;
  readonly systemPrompt: string;
  readonly tools: readonly ModelToolSpec[];
  readonly model: ContextModelLimits;
}): ContextDraft {
  return {
    systemPrompt: input.systemPrompt,
    messages: cloneTranscriptMessages(input.source.messages),
    tools: input.tools.map(cloneModelToolSpec),
    model: { ...input.model },
  };
}

export function cloneContextDraft(draft: ContextDraft): ContextDraft {
  return {
    systemPrompt: draft.systemPrompt,
    messages: cloneTranscriptMessages(draft.messages),
    tools: draft.tools.map(cloneModelToolSpec),
    model: { ...draft.model },
  };
}

export function cloneModelToolSpec(tool: ModelToolSpec): ModelToolSpec {
  return {
    name: tool.name,
    description: tool.description,
    schema: cloneData(tool.schema),
    ...(tool.inputConstraint === undefined ? {} : { inputConstraint: tool.inputConstraint }),
  };
}
