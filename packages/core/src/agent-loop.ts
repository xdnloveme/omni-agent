import { randomUUID } from "node:crypto";
import type {
  TranscriptMessage,
  AssistantTranscriptMessage,
  ModelUsage,
  ToolCallContent,
} from "./messages";
import type { PreparedModelContext } from "./context";
import type { AgentConfig, AgentEvent, AgentFailure, AgentLoopInput, TokenUsage } from "./types";
import type { StreamEvent, StreamSession } from "./stream/index";
import { isAbortError, throwIfAborted } from "./execution";
import { createLoopProtection } from "./loop-protection";
import { cloneData } from "./dataCopy";
import { cloneTranscriptMessage } from "./messages";
import { createContextPreparationRequest } from "./agent/contextInput";
import { WorkingConversation } from "./agent/workingConversation";
import { createContextPreparationStream } from "./agent/contextPreparationStream";
import { createToolBatchDescriptor, firstTurnBarrierIndex } from "./agent/toolBatch";
import { EnvironmentContextError } from "./environment";
import {
  NOOP_RUNTIME_RUN_OBSERVATION,
  iterateObserved,
  type RuntimeRunObservation,
  type RuntimeToolBatchObservation,
} from "./runtime-observation";

export interface AgentLoopOptions {
  /** Optional StreamSession for state-machine-driven event dispatch */
  session?: StreamSession;
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

/**
 * Run the agent loop as an async generator.
 * Yields AgentEvent as the loop progresses.
 *
 * The caller provides a detached Session transcript snapshot.
 * The loop appends assistant and tool_result messages internally and
 * yields them back via the `produced` field on the final "done" event.
 *
 * When a StreamSession is provided via options, events are also dispatched
 * through the session's state machine, enabling callback-driven consumers
 * (TUI, harness, test mocks) without coupling to the generator protocol.
 */
export async function* runAgentLoop(input: AgentLoopInput): AsyncGenerator<AgentEvent> {
  const { config, contextEngine, contextMiddleware, modelRuntime, signal, options } = input;
  const conversation = WorkingConversation.from(input.snapshot);
  const maxTurns = config.maxTurns;
  const session = options?.session;
  const loopProtection = createLoopProtection();
  const runObservation = input.observation ?? NOOP_RUNTIME_RUN_OBSERVATION;

  // Track the latest usage from the last LLM response
  let lastUsage: TokenUsage | undefined;
  const contextWindow = config.model.contextWindow;
  const toolCallCoordinator = input.toolCallCoordinator;

  for (let turn = 0; maxTurns === undefined || turn < maxTurns; turn++) {
    throwIfAborted(signal);
    const turnObservation = runObservation.startTurn({ turn });
    const observe = <T extends AgentEvent & StreamEvent>(
      event: T,
      sessionEvent: StreamEvent = event,
    ): T => {
      session?.handle(sessionEvent);
      return event;
    };

    try {
      const captureObservation = turnObservation.startOperation({
        kind: "environment_capture",
        turn,
      });
      try {
        const capture = await captureObservation.run(() =>
          input.environmentContext.capture(conversation.snapshot().environment, signal),
        );
        captureObservation.complete({});
        if (capture.changed) conversation.updateEnvironment(capture.context);
      } catch (error) {
        if (isAbortError(error, signal)) captureObservation.cancel({ error });
        else captureObservation.fail({ error });
        if (!(error instanceof EnvironmentContextError)) throw error;
        const agentEvent: AgentEvent = {
          type: "error",
          failure: {
            code: error.code,
            message: error.message,
            retryable: error.retryable,
            ...(error.field ? { field: error.field } : {}),
          },
          produced: conversation.produced(),
          usage: lastUsage,
        };
        turnObservation.fail({ turn, failure: agentEvent.failure });
        yield observe(agentEvent, { type: "error", failure: agentEvent.failure });
        return;
      }

      // Call LLM
      let assistantMessage: AssistantTranscriptMessage | null = null;

      const promptLease = loopProtection.leaseSystemPrompt(
        config.systemPrompt,
        config.tools.length > 0,
      );
      const conversationSnapshot = conversation.snapshot();
      const environment = conversationSnapshot.environment;
      if (!environment) throw new Error("Environment context is missing after capture");
      const contextObservation = turnObservation.startContext({ turn });
      let preparation: ReturnType<typeof createContextPreparationStream>;
      let preparedContext: PreparedModelContext;
      try {
        preparation = contextObservation.run(() =>
          createContextPreparationStream(contextEngine, (progress) =>
            createContextPreparationRequest({
              identity: {
                agentId: input.agentId,
                sessionId: conversationSnapshot.sessionId,
                sessionRevision: conversationSnapshot.sessionRevision,
                modelCallId: randomUUID(),
              },
              conversation: conversationSnapshot,
              systemPrompt: promptLease.systemPrompt,
              tools: config.tools,
              model: {
                modelId: config.model.modelId,
                contextWindow: config.model.contextWindow,
                modelMaxOutputTokens: config.model.modelMaxOutputTokens,
                requestedOutputTokens: config.model.requestedOutputTokens,
              },
              middleware: contextMiddleware,
              progress,
              signal,
            }),
          ),
        );
        for await (const event of iterateObserved(contextObservation, () => preparation.progress)) {
          contextObservation.progress({ turn, event: cloneData(event) });
          const progressEvent: AgentEvent = { type: "context_progress", event: cloneData(event) };
          yield observe(progressEvent);
        }
        preparedContext = await contextObservation.run(() => preparation.result());
        contextObservation.prepared({ turn, context: preparedContext });
        contextObservation.complete({});
      } catch (error) {
        if (isAbortError(error, signal)) contextObservation.cancel({ error });
        else contextObservation.fail({ error });
        throw error;
      }
      const estimatedInputTokens = preparedContext.manifest.estimatedInputTokens;
      const contextEvent: AgentEvent = {
        type: "model_context_prepared",
        manifest: cloneData(preparedContext.manifest),
      };
      yield observe(contextEvent);
      const modelStartedAt = Date.now();
      const modelObservation = turnObservation.startModelCall({
        turn,
        modelCallId: preparedContext.manifest.modelCallId,
        modelId: config.model.modelId,
        estimatedInputTokens,
      });
      modelObservation.requestCaptured({ context: preparedContext, selection: config.model });
      let promptDispatchObserved = false;
      let firstModelEventObserved = false;
      let timeToFirstEventMs: number | undefined;
      let textSegmentSequence = 0;
      let activeTextSegmentId: string | undefined;

      try {
        const eventStream = modelObservation.run(() =>
          modelRuntime.stream(config.model, preparedContext, {
            identity: {
              agentId: input.agentId,
              sessionId: conversationSnapshot.sessionId,
              modelCallId: preparedContext.manifest.modelCallId,
              contextSnapshotId: preparedContext.snapshotId,
              purpose: "primary",
            },
            cache: { retention: "default" },
            maxOutputTokens: config.model.requestedOutputTokens,
            signal,
          }),
        );
        for await (const event of iterateObserved(modelObservation, () =>
          eventStream[Symbol.asyncIterator](),
        )) {
          if (!firstModelEventObserved) {
            firstModelEventObserved = true;
            timeToFirstEventMs = Math.max(0, Date.now() - modelStartedAt);
          }
          if (!promptDispatchObserved) {
            loopProtection.markPromptDispatched(promptLease.id);
            promptDispatchObserved = true;
          }
          throwIfAborted(signal);
          if (event.type === "text_delta") {
            activeTextSegmentId ??= `${preparedContext.manifest.modelCallId}:text:${textSegmentSequence++}`;
            const agentEvent: AgentEvent = {
              type: "text_delta",
              modelCallId: preparedContext.manifest.modelCallId,
              textSegmentId: activeTextSegmentId,
              delta: event.delta,
            };
            modelObservation.output({ kind: "text_delta", ...agentEvent });
            yield observe(agentEvent);
          }
          if (event.type === "thinking_start") {
            activeTextSegmentId = undefined;
            const thinkingEvent: AgentEvent = {
              type: "thinking_start",
              modelCallId: preparedContext.manifest.modelCallId,
              contentIndex: event.contentIndex,
            };
            modelObservation.output({
              kind: "thinking_started",
              modelCallId: thinkingEvent.modelCallId,
              contentIndex: thinkingEvent.contentIndex,
            });
            yield observe(thinkingEvent);
          }
          if (event.type === "thinking_delta") {
            activeTextSegmentId = undefined;
            const thinkingEvent: AgentEvent = {
              type: "thinking_delta",
              modelCallId: preparedContext.manifest.modelCallId,
              contentIndex: event.contentIndex,
              delta: event.delta,
            };
            modelObservation.output({
              kind: "thinking_delta",
              modelCallId: thinkingEvent.modelCallId,
              contentIndex: thinkingEvent.contentIndex,
              delta: thinkingEvent.delta,
            });
            yield observe(thinkingEvent);
          }
          if (event.type === "thinking_end") {
            activeTextSegmentId = undefined;
            const thinkingEvent: AgentEvent = {
              type: "thinking_end",
              modelCallId: preparedContext.manifest.modelCallId,
              contentIndex: event.contentIndex,
              content: event.content,
            };
            modelObservation.output({
              kind: "thinking_completed",
              modelCallId: thinkingEvent.modelCallId,
              contentIndex: thinkingEvent.contentIndex,
              content: thinkingEvent.content,
            });
            yield observe(thinkingEvent);
          }
          if (event.type === "cache_report") {
            const cacheEvent: AgentEvent = {
              type: "model_cache_report",
              report: cloneData(event.report),
            };
            modelObservation.output({ kind: "cache_reported", report: cacheEvent.report });
            yield observe(cacheEvent);
          }
          if (event.type === "done") {
            assistantMessage = cloneTranscriptMessage(event.message);
          }
          if (event.type === "error") {
            const errorMsg = event.error.errorMessage ?? "LLM error";
            const failure = { code: "model_runtime_error", message: errorMsg, retryable: true };
            const produced = conversation.produced();
            modelObservation.fail({ failure, error: errorMsg });
            turnObservation.fail({ turn, failure });
            yield observe(
              {
                type: "error",
                failure,
                ...(produced.length > 0 ? { produced } : {}),
              },
              { type: "error", failure },
            );
            return;
          }
        }
        if (!promptDispatchObserved) loopProtection.markPromptDispatched(promptLease.id);
        throwIfAborted(signal);

        if (!assistantMessage) {
          const produced = conversation.produced();
          const failure = {
            code: "model_response_missing",
            message: "No response from LLM",
            retryable: true,
          };
          modelObservation.fail({ failure, error: failure.message });
          turnObservation.fail({ turn, failure });
          yield observe(
            {
              type: "error",
              failure,
              ...(produced.length > 0 ? { produced } : {}),
            },
            { type: "error", failure },
          );
          return;
        }

        for (const middleware of config.middleware ?? []) {
          await middleware.afterModel?.(
            cloneData({ request: preparedContext, response: assistantMessage }),
          );
        }
        throwIfAborted(signal);
        conversation.append(assistantMessage);

        // Extract usage from the assistant message. Context occupancy includes cached prompt
        // tokens; provider usage may report those separately from fresh input tokens.
        lastUsage = toTokenUsage(
          assistantMessage.usage,
          estimatedInputTokens,
          contextWindow,
          preparedContext.manifest.usableInputBudget,
          preparedContext.manifest.requestedOutputTokens,
        );
        modelObservation.complete({
          response: assistantMessage,
          usage: lastUsage,
          ...(timeToFirstEventMs === undefined ? {} : { timeToFirstEventMs }),
        });
      } catch (error) {
        if (isAbortError(error, signal)) modelObservation.cancel({ error });
        else {
          modelObservation.fail({
            failure: runtimeFailure("model_runtime_error", error, true),
            error,
          });
        }
        throw error;
      }

      // Check stop reason
      if (assistantMessage.stopReason !== "toolUse") {
        if (isFinalTextResponse(assistantMessage)) {
          const finalResponseEvent: AgentEvent = {
            type: "final_response",
            modelCallId: preparedContext.manifest.modelCallId,
          };
          turnObservation.finalResponse({ modelCallId: finalResponseEvent.modelCallId });
          yield observe(finalResponseEvent);
        }
        session?.handle({ type: "done", usage: lastUsage });
        turnObservation.complete({ turn, usage: lastUsage });
        yield { type: "done", produced: conversation.produced(), usage: lastUsage };
        return;
      }

      // Extract and execute tool calls
      const toolCalls = assistantMessage.content.filter(
        (block): block is ToolCallContent => block.type === "toolCall",
      );
      loopProtection.beginToolBatch(toolCalls);
      const toolResultMessages: TranscriptMessage[] = [];
      const batchStartedAt = Date.now();
      const batch = createToolBatchDescriptor(
        toolCalls,
        config.tools,
        preparedContext.manifest.modelCallId,
      );
      const batchStartedEvent: AgentEvent = {
        type: "tool_batch_started",
        batch: cloneData(batch),
      };
      const batchObservation = turnObservation.startToolBatch({ batch });
      try {
        yield observe(batchStartedEvent, {
          type: "tool_batch_started",
          batch: cloneData(batch),
        });

        // Scheduling is resolved before any member reaches authorization.
        const turnBarrierIndex = firstTurnBarrierIndex(toolCalls, config.tools);

        for (const [index, call] of toolCalls.entries()) {
          throwIfAborted(signal);
          const position = { batchId: batch.batchId, index, total: toolCalls.length };
          const preview = batch.members[index]!.preview;

          let result: import("./tool-calls").ValidatedToolResult | undefined;
          if (turnBarrierIndex !== undefined && index !== turnBarrierIndex) {
            result = deferredToolResult();
            const deferredMetrics = { authorizationMs: 0, executionMs: 0, totalMs: 0 };
            observeDeferredToolCall(
              batchObservation,
              call,
              batch.batchId,
              result,
              deferredMetrics,
              config.tools.find((tool) => tool.name === call.name)?.authorization.hiddenInputKeys,
            );
            yield publishToolStart(session, call.name, call.id, call.arguments, preview, position);
            yield publishToolEnd(session, call.name, call.id, result, 0, position, deferredMetrics);
          } else
            for await (const event of iterateObserved(batchObservation, () =>
              toolCallCoordinator.run(
                config.tools,
                { toolName: call.name, toolCallId: call.id, input: call.arguments, signal },
                {
                  agentId: input.agentId,
                  batchId: batch.batchId,
                  cwd: environment.snapshot.workspace.cwd,
                  middleware: config.middleware ?? [],
                  lifecycleAdapters: config.toolLifecycleAdapters ?? [],
                },
                batchObservation,
              ),
            )) {
              if (event.type === "tool_start") {
                yield publishToolStart(
                  session,
                  event.toolName,
                  event.toolCallId,
                  event.input,
                  preview,
                  position,
                );
              } else if (event.type === "tool_end") {
                result = event.result;
                yield publishToolEnd(
                  session,
                  event.toolName,
                  event.toolCallId,
                  event.result,
                  event.durationMs,
                  position,
                  event.metrics,
                );
              } else {
                session?.handle(event);
                yield event;
              }
            }
          throwIfAborted(signal);
          if (!result) throw new Error(`Tool call completed without a result: ${call.name}`);
          loopProtection.observeToolResult({
            call,
            toolIdentity: config.tools.find((tool) => tool.name === call.name)?.toolIdentity,
            result,
          });

          // Push tool result message
          const toolResultMsg: TranscriptMessage = {
            role: "toolResult",
            toolCallId: call.id,
            toolName: call.name,
            content: result.content,
            ...(result.transcriptDetails === undefined
              ? {}
              : { details: cloneData(result.transcriptDetails) }),
            isError: result.isError,
            timestamp: Date.now(),
          };
          toolResultMessages.push(toolResultMsg);
        }

        const batchCompletedEvent: AgentEvent = {
          type: "tool_batch_completed",
          batchId: batch.batchId,
          modelCallId: preparedContext.manifest.modelCallId,
          durationMs: Math.max(0, Date.now() - batchStartedAt),
        };
        batchObservation.complete(batchCompletedEvent);
        yield observe(batchCompletedEvent);
      } catch (error) {
        if (isAbortError(error, signal)) batchObservation.cancel({ error });
        else batchObservation.fail({ error });
        throw error;
      }

      const loopDecision = loopProtection.completeToolBatch();
      for (const message of toolResultMessages) conversation.append(message);
      if (loopDecision.type === "halt") {
        const failure = {
          code: "tool_loop_detected",
          message: loopDecision.error,
          retryable: false,
        };
        turnObservation.fail({ turn, failure });
        yield observe(
          {
            type: "error",
            failure,
            loop: loopDecision.diagnostic,
            produced: conversation.produced(),
            usage: lastUsage,
          },
          { type: "error", failure },
        );
        return;
      }

      // Continue loop for next LLM turn
      if (maxTurns !== undefined && turn + 1 >= maxTurns) {
        turnObservation.fail({
          turn,
          failure: maxTurnsFailure(maxTurns),
        });
      } else {
        turnObservation.complete({ turn, usage: lastUsage });
      }
    } catch (error) {
      if (isAbortError(error, signal)) turnObservation.cancel({ error });
      else
        turnObservation.fail({ turn, failure: runtimeFailure("agent_turn_failed", error, false) });
      throw error;
    }
  }

  if (maxTurns !== undefined) {
    const failure = maxTurnsFailure(maxTurns);
    session?.handle({ type: "error", failure });
    const agentEvent: AgentEvent = {
      type: "error",
      failure,
      produced: conversation.produced(),
      usage: lastUsage,
      turnCount: maxTurns,
      maxTurns,
    };
    yield agentEvent;
  }
}

function maxTurnsFailure(maxTurns: number): AgentFailure {
  return {
    code: "max_turns_reached",
    message: `Max turns reached (${maxTurns})`,
    retryable: false,
  };
}

function runtimeFailure(code: string, error: unknown, retryable: boolean): AgentFailure {
  return {
    code,
    message: error instanceof Error ? error.message : String(error),
    retryable,
  };
}

function isFinalTextResponse(message: AssistantTranscriptMessage): boolean {
  return (
    message.stopReason === "stop" &&
    message.content.some((content) => content.type === "text" && content.text.length > 0)
  );
}

function deferredToolResult(): import("./tool-calls").ValidatedToolResult {
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
  batchObservation: RuntimeToolBatchObservation,
  call: ToolCallContent,
  batchId: string,
  result: import("./tool-calls").ValidatedToolResult,
  metrics: import("./tool-calls").ToolCallMetrics,
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
  preview: import("./types").ToolInvocationPreview,
  batch: import("./types").ToolBatchPosition,
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
  result: import("./tool-calls").ValidatedToolResult,
  durationMs: number,
  batch: import("./types").ToolBatchPosition,
  metrics?: import("./tool-calls").ToolCallMetrics,
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
