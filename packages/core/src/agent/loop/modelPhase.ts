import type { PreparedModelContext } from "../../context";
import { cloneData } from "../../dataCopy";
import { isAbortError, throwIfAborted } from "../../execution";
import {
  cloneTranscriptMessage,
  type AssistantTranscriptMessage,
  type ModelUsage,
} from "../../messages";
import type { ModelRuntimePort } from "../../models/runtime";
import type { LoopProtection } from "../../loop-protection";
import { iterateObserved, type RuntimeTurnObservation } from "../../runtime-observation";
import type { AgentConfig, AgentEvent, TokenUsage } from "../../types";
import type { WorkingConversation } from "../workingConversation";
import type { ModelPhaseResult, PublishAgentEvent } from "./types";
import { runtimeFailure } from "./failures";

export interface ModelPhaseInput {
  readonly turn: number;
  readonly agentId: string;
  readonly sessionId: string;
  readonly config: AgentConfig;
  readonly preparedContext: PreparedModelContext;
  readonly promptLeaseId: string | undefined;
  readonly conversation: WorkingConversation;
  readonly modelRuntime: ModelRuntimePort;
  readonly loopProtection: LoopProtection;
  readonly observation: RuntimeTurnObservation;
  readonly publish: PublishAgentEvent;
  readonly recovery?: { readonly attempt: number; readonly parentModelCallId: string };
  readonly signal?: AbortSignal;
}

export async function* streamModelPhase(
  input: ModelPhaseInput,
): AsyncGenerator<AgentEvent, ModelPhaseResult> {
  const estimatedInputTokens = input.preparedContext.manifest.estimatedInputTokens;
  const modelStartedAt = Date.now();
  const observation = input.observation.startModelCall({
    turn: input.turn,
    modelCallId: input.preparedContext.manifest.modelCallId,
    modelId: input.config.model.modelId,
    estimatedInputTokens,
  });
  observation.requestCaptured({
    context: input.preparedContext,
    selection: input.config.model,
    recovery: input.recovery,
  });
  let assistantMessage: AssistantTranscriptMessage | null = null;
  let promptDispatchObserved = false;
  let firstModelEventObserved = false;
  let timeToFirstEventMs: number | undefined;
  let textSegmentSequence = 0;
  let activeTextSegmentId: string | undefined;

  try {
    const eventStream = observation.run(() =>
      input.modelRuntime.stream(input.config.model, input.preparedContext, {
        identity: {
          agentId: input.agentId,
          sessionId: input.sessionId,
          modelCallId: input.preparedContext.manifest.modelCallId,
          contextSnapshotId: input.preparedContext.snapshotId,
          purpose: "primary",
        },
        cache: { retention: "default" },
        maxOutputTokens: input.preparedContext.manifest.requestedOutputTokens,
        signal: input.signal,
      }),
    );
    for await (const event of iterateObserved(observation, () =>
      eventStream[Symbol.asyncIterator](),
    )) {
      if (event.type === "tool_constraint_report") {
        observation.output({
          kind: "tool_constraints_reported",
          modelCallId: input.preparedContext.manifest.modelCallId,
          report: cloneData(event.report),
        });
        if (event.report.failure) {
          const failure = cloneData(event.report.failure);
          observation.fail({ failure });
          const produced = input.conversation.produced();
          return {
            kind: "failed",
            event: { type: "error", failure, ...(produced.length ? { produced } : {}) },
          };
        }
        continue;
      }
      if (!firstModelEventObserved) {
        firstModelEventObserved = true;
        timeToFirstEventMs = Math.max(0, Date.now() - modelStartedAt);
      }
      if (!promptDispatchObserved) {
        input.loopProtection.markPromptDispatched(input.promptLeaseId);
        promptDispatchObserved = true;
      }
      throwIfAborted(input.signal);
      if (event.type === "text_delta") {
        activeTextSegmentId ??= `${input.preparedContext.manifest.modelCallId}:text:${textSegmentSequence++}`;
        const agentEvent: AgentEvent = {
          type: "text_delta",
          modelCallId: input.preparedContext.manifest.modelCallId,
          textSegmentId: activeTextSegmentId,
          delta: event.delta,
        };
        observation.output({ kind: "text_delta", ...agentEvent });
        yield input.publish(agentEvent);
      }
      if (event.type === "thinking_start") {
        activeTextSegmentId = undefined;
        const thinkingEvent: AgentEvent = {
          type: "thinking_start",
          modelCallId: input.preparedContext.manifest.modelCallId,
          contentIndex: event.contentIndex,
        };
        observation.output({
          kind: "thinking_started",
          modelCallId: thinkingEvent.modelCallId,
          contentIndex: thinkingEvent.contentIndex,
        });
        yield input.publish(thinkingEvent);
      }
      if (event.type === "thinking_delta") {
        activeTextSegmentId = undefined;
        const thinkingEvent: AgentEvent = {
          type: "thinking_delta",
          modelCallId: input.preparedContext.manifest.modelCallId,
          contentIndex: event.contentIndex,
          delta: event.delta,
        };
        observation.output({
          kind: "thinking_delta",
          modelCallId: thinkingEvent.modelCallId,
          contentIndex: thinkingEvent.contentIndex,
          delta: thinkingEvent.delta,
        });
        yield input.publish(thinkingEvent);
      }
      if (event.type === "thinking_end") {
        activeTextSegmentId = undefined;
        const thinkingEvent: AgentEvent = {
          type: "thinking_end",
          modelCallId: input.preparedContext.manifest.modelCallId,
          contentIndex: event.contentIndex,
          content: event.content,
        };
        observation.output({
          kind: "thinking_completed",
          modelCallId: thinkingEvent.modelCallId,
          contentIndex: thinkingEvent.contentIndex,
          content: thinkingEvent.content,
        });
        yield input.publish(thinkingEvent);
      }
      if (event.type === "cache_report") {
        const cacheEvent: AgentEvent = {
          type: "model_cache_report",
          report: cloneData(event.report),
        };
        observation.output({ kind: "cache_reported", report: cacheEvent.report });
        yield input.publish(cacheEvent);
      }
      if (event.type === "done") {
        assistantMessage = cloneTranscriptMessage(event.message);
      }
      if (event.type === "error") {
        const errorMsg = event.error.errorMessage ?? "LLM error";
        const failure = { code: "model_runtime_error", message: errorMsg, retryable: true };
        const produced = input.conversation.produced();
        observation.fail({ failure, error: errorMsg });
        return {
          kind: "failed",
          event: {
            type: "error",
            failure,
            ...(produced.length > 0 ? { produced } : {}),
          },
        };
      }
    }
    if (!promptDispatchObserved) input.loopProtection.markPromptDispatched(input.promptLeaseId);
    throwIfAborted(input.signal);

    if (!assistantMessage) {
      const produced = input.conversation.produced();
      const failure = {
        code: "model_response_missing",
        message: "No response from LLM",
        retryable: true,
      };
      observation.fail({ failure, error: failure.message });
      return {
        kind: "failed",
        event: {
          type: "error",
          failure,
          ...(produced.length > 0 ? { produced } : {}),
        },
      };
    }

    for (const middleware of input.config.middleware ?? []) {
      await middleware.afterModel?.(
        cloneData({ request: input.preparedContext, response: assistantMessage }),
      );
    }
    throwIfAborted(input.signal);
    input.conversation.append(assistantMessage);

    const usage = toTokenUsage(
      assistantMessage.usage,
      estimatedInputTokens,
      input.config.model.contextWindow,
      input.preparedContext.manifest.usableInputBudget,
      input.preparedContext.manifest.requestedOutputTokens,
    );
    observation.complete({
      response: assistantMessage,
      usage,
      ...(timeToFirstEventMs === undefined ? {} : { timeToFirstEventMs }),
    });
    return {
      kind: "response",
      response: assistantMessage,
      usage,
      modelCallId: input.preparedContext.manifest.modelCallId,
    };
  } catch (error) {
    if (isAbortError(error, input.signal)) observation.cancel({ error });
    else {
      observation.fail({
        failure: runtimeFailure("model_runtime_error", error, true),
        error,
      });
    }
    throw error;
  }
}

function toTokenUsage(
  usage: ModelUsage | undefined,
  estimatedInputTokens: number,
  contextWindow: number,
  usableInputBudget: number,
  requestedOutputTokens: number,
): TokenUsage {
  if (!usage) {
    return {
      inputTokens: estimatedInputTokens,
      outputTokens: 0,
      totalTokens: estimatedInputTokens,
      contextWindow,
      usableInputBudget,
      requestedOutputTokens,
      estimated: true,
    };
  }
  const reportedInputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  const inputTokens = Math.max(reportedInputTokens, estimatedInputTokens);
  return {
    inputTokens,
    outputTokens: usage.output,
    totalTokens: inputTokens + usage.output,
    contextWindow,
    usableInputBudget,
    requestedOutputTokens,
    estimated: inputTokens !== reportedInputTokens,
  };
}
