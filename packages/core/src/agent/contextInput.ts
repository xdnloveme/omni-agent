import { cloneData } from "../dataCopy";
import { cloneTranscriptMessages } from "../messages";
import type {
  ContextMiddlewarePort,
  ContextModelLimits,
  ContextPreparationRequest,
  ContextProgressSinkPort,
} from "../context";
import type { ModelToolSpec } from "../models/runtime";
import type { RegisteredAgentTool } from "../types";
import type { WorkingConversationSnapshot } from "./workingConversation";

export interface CreateContextPreparationRequestInput {
  readonly identity: ContextPreparationRequest["identity"];
  readonly conversation: WorkingConversationSnapshot;
  readonly systemPrompt: string;
  readonly tools: readonly RegisteredAgentTool[];
  readonly model: ContextModelLimits;
  readonly middleware: readonly ContextMiddlewarePort[];
  readonly progress: ContextProgressSinkPort;
  readonly signal?: AbortSignal;
  readonly runDeadline?: import("../execution/run-deadline").RunDeadlineSnapshot;
}

export function createContextPreparationRequest(
  input: CreateContextPreparationRequestInput,
): ContextPreparationRequest {
  return {
    identity: { ...input.identity },
    runDeadline: input.runDeadline,
    source: { messages: cloneTranscriptMessages(input.conversation.messages) },
    ...(input.conversation.environment
      ? { environment: cloneData(input.conversation.environment) }
      : {}),
    systemPrompt: input.systemPrompt,
    tools: input.tools.map(toModelToolSpec),
    model: { ...input.model },
    middleware: [...input.middleware],
    progress: input.progress,
    signal: input.signal,
  };
}

function toModelToolSpec(tool: RegisteredAgentTool): ModelToolSpec {
  return {
    name: tool.name,
    description: tool.description,
    schema: cloneData(tool.schema),
    ...(tool.inputConstraint === undefined ? {} : { inputConstraint: tool.inputConstraint }),
  };
}
