import { cloneData } from "../../dataCopy";
import { isAbortError, throwIfAborted } from "../../execution";
import type { EnvironmentContextRecord } from "../../environment";
import type { LoopProtection } from "../../loop-protection";
import type {
  AssistantTranscriptMessage,
  ToolCallContent,
  TranscriptMessage,
} from "../../messages";
import { iterateObserved, type RuntimeTurnObservation } from "../../runtime-observation";
import type { StreamSession } from "../../stream";
import type { ToolCallCoordinator, ToolCallMetrics, ValidatedToolResult } from "../../tool-calls";
import type { AgentConfig, AgentEvent } from "../../types";
import { createToolBatchDescriptor, firstTurnBarrierIndex } from "../toolBatch";
import type { PublishAgentEvent, ToolBatchPhaseResult } from "./types";

export interface ToolBatchPhaseInput {
  readonly agentId: string;
  readonly config: AgentConfig;
  readonly response: AssistantTranscriptMessage;
  readonly modelCallId: string;
  readonly environment: EnvironmentContextRecord;
  readonly coordinator: ToolCallCoordinator;
  readonly loopProtection: LoopProtection;
  readonly observation: RuntimeTurnObservation;
  readonly publish: PublishAgentEvent;
  readonly session?: StreamSession;
  readonly signal?: AbortSignal;
}

export async function* executeToolBatchPhase(
  input: ToolBatchPhaseInput,
): AsyncGenerator<AgentEvent, ToolBatchPhaseResult> {
  const toolCalls = input.response.content.filter(
    (block): block is ToolCallContent => block.type === "toolCall",
  );
  input.loopProtection.beginToolBatch(toolCalls);
  const toolResultMessages: TranscriptMessage[] = [];
  const batchStartedAt = Date.now();
  const batch = createToolBatchDescriptor(toolCalls, input.config.tools, input.modelCallId);
  const batchStartedEvent: AgentEvent = {
    type: "tool_batch_started",
    batch: cloneData(batch),
  };
  const observation = input.observation.startToolBatch({ batch });
  try {
    yield input.publish(batchStartedEvent, {
      type: "tool_batch_started",
      batch: cloneData(batch),
    });

    const turnBarrierIndex = firstTurnBarrierIndex(toolCalls, input.config.tools);

    for (const [index, call] of toolCalls.entries()) {
      throwIfAborted(input.signal);
      const position = { batchId: batch.batchId, index, total: toolCalls.length };
      const preview = batch.members[index]!.preview;

      let result: ValidatedToolResult | undefined;
      if (turnBarrierIndex !== undefined && index !== turnBarrierIndex) {
        result = deferredToolResult();
        const deferredMetrics = { authorizationMs: 0, executionMs: 0, totalMs: 0 };
        observeDeferredToolCall(
          observation,
          call,
          batch.batchId,
          result,
          deferredMetrics,
          input.config.tools.find((tool) => tool.name === call.name)?.authorization.hiddenInputKeys,
        );
        yield publishToolStart(
          input.session,
          call.name,
          call.id,
          call.arguments,
          preview,
          position,
        );
        yield publishToolEnd(
          input.session,
          call.name,
          call.id,
          result,
          0,
          position,
          deferredMetrics,
        );
      } else {
        for await (const event of iterateObserved(observation, () =>
          input.coordinator.run(
            input.config.tools,
            {
              toolName: call.name,
              toolCallId: call.id,
              input: call.arguments,
              signal: input.signal,
            },
            {
              agentId: input.agentId,
              batchId: batch.batchId,
              cwd: input.environment.snapshot.workspace.cwd,
              middleware: input.config.middleware ?? [],
              lifecycleAdapters: input.config.toolLifecycleAdapters ?? [],
            },
            observation,
          ),
        )) {
          if (event.type === "tool_start") {
            yield publishToolStart(
              input.session,
              event.toolName,
              event.toolCallId,
              event.input,
              preview,
              position,
            );
          } else if (event.type === "tool_end") {
            result = event.result;
            yield publishToolEnd(
              input.session,
              event.toolName,
              event.toolCallId,
              event.result,
              event.durationMs,
              position,
              event.metrics,
            );
          } else {
            input.session?.handle(event);
            yield event;
          }
        }
      }
      throwIfAborted(input.signal);
      if (!result) throw new Error(`Tool call completed without a result: ${call.name}`);
      input.loopProtection.observeToolResult({
        call,
        toolIdentity: input.config.tools.find((tool) => tool.name === call.name)?.toolIdentity,
        result,
      });

      toolResultMessages.push({
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: result.content,
        ...(result.transcriptDetails === undefined
          ? {}
          : { details: cloneData(result.transcriptDetails) }),
        isError: result.isError,
        timestamp: Date.now(),
      });
    }

    const batchCompletedEvent: AgentEvent = {
      type: "tool_batch_completed",
      batchId: batch.batchId,
      modelCallId: input.modelCallId,
      durationMs: Math.max(0, Date.now() - batchStartedAt),
    };
    observation.complete(batchCompletedEvent);
    yield input.publish(batchCompletedEvent);
  } catch (error) {
    if (isAbortError(error, input.signal)) observation.cancel({ error });
    else observation.fail({ error });
    throw error;
  }

  const loopDecision = input.loopProtection.completeToolBatch();
  if (loopDecision.type === "halt") {
    return {
      kind: "halt",
      messages: toolResultMessages,
      failure: {
        code: "tool_loop_detected",
        message: loopDecision.error,
        retryable: false,
      },
      diagnostic: loopDecision.diagnostic,
    };
  }
  return { kind: "continue", messages: toolResultMessages };
}

function deferredToolResult(): ValidatedToolResult {
  const details = { code: "tool_batch_deferred", retryable: true } as const;
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: "This call was not executed because the batch contained a turn barrier. Reissue it if it is still needed.",
      },
    ],
    meta: details,
    transcriptDetails: details,
  };
}

function observeDeferredToolCall(
  batchObservation: import("../../runtime-observation").RuntimeToolBatchObservation,
  call: ToolCallContent,
  batchId: string,
  result: ValidatedToolResult,
  metrics: ToolCallMetrics,
  hiddenInputKeys?: readonly string[],
): void {
  const observation = batchObservation.startCall({
    toolName: call.name,
    toolCallId: call.id,
    batchId,
    input: call.arguments,
    ...(hiddenInputKeys ? { hiddenInputKeys } : {}),
  });
  observation.result({
    toolName: call.name,
    toolCallId: call.id,
    batchId,
    result,
    metrics,
  });
  observation.complete({ result });
}

function publishToolStart(
  session: StreamSession | undefined,
  toolName: string,
  toolCallId: string,
  input: Record<string, unknown>,
  preview: import("../../types").ToolInvocationPreview,
  batch: import("../../types").ToolBatchPosition,
): Extract<AgentEvent, { type: "tool_start" }> {
  const event = {
    type: "tool_start" as const,
    toolName,
    toolCallId,
    input: cloneData(input),
    preview: cloneData(preview),
    batch: { ...batch },
  };
  const { type: _type, ...streamEvent } = cloneData(event);
  session?.handle({ type: "tool_use_start", ...streamEvent });
  return event;
}

function publishToolEnd(
  session: StreamSession | undefined,
  toolName: string,
  toolCallId: string,
  result: ValidatedToolResult,
  durationMs: number,
  batch: import("../../types").ToolBatchPosition,
  metrics?: ToolCallMetrics,
): Extract<AgentEvent, { type: "tool_end" }> {
  const event = {
    type: "tool_end" as const,
    toolName,
    toolCallId,
    result: cloneData(result),
    durationMs,
    batch: { ...batch },
    ...(metrics ? { metrics: cloneData(metrics) } : {}),
  };
  const { type: _type, ...streamEvent } = cloneData(event);
  session?.handle({ type: "tool_use_end", ...streamEvent });
  return event;
}
