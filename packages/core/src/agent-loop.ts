import { randomUUID } from "node:crypto";
import type {
  TranscriptMessage,
  AssistantTranscriptMessage,
  ModelUsage,
  ToolCallContent,
} from "./messages";
import type { AgentConfig, AgentEvent, AgentLoopInput, TokenUsage } from "./types";
import type { StreamSession } from "./stream/index";
import { throwIfAborted } from "./execution";
import { createLoopProtection } from "./loop-protection";
import { cloneData } from "./dataCopy";
import { cloneTranscriptMessage } from "./messages";
import { createContextPreparationRequest } from "./agent/contextInput";
import { WorkingConversation } from "./agent/workingConversation";

export interface AgentLoopOptions {
  /** Optional StreamSession for state-machine-driven event dispatch */
  session?: StreamSession;
}

function toTokenUsage(
  usage: ModelUsage | undefined,
  estimatedInputTokens: number,
  contextWindow: number,
): TokenUsage {
  if (!usage) {
    return {
      inputTokens: estimatedInputTokens,
      outputTokens: 0,
      totalTokens: estimatedInputTokens,
      contextWindow,
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

  // Track the latest usage from the last LLM response
  let lastUsage: TokenUsage | undefined;
  const contextWindow = config.model.contextWindow;
  const toolCallCoordinator = input.toolCallCoordinator;

  for (let turn = 0; maxTurns === undefined || turn < maxTurns; turn++) {
    throwIfAborted(signal);

    // Call LLM
    let assistantMessage: AssistantTranscriptMessage | null = null;

    const promptLease = loopProtection.leaseSystemPrompt(
      config.systemPrompt,
      config.tools.length > 0,
    );
    const conversationSnapshot = conversation.snapshot();
    const preparedContext = await contextEngine.prepare(
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
          maxOutputTokens: config.model.maxOutputTokens,
        },
        middleware: contextMiddleware,
        signal,
      }),
    );
    const estimatedInputTokens = preparedContext.manifest.estimatedInputTokens;
    const contextEvent: AgentEvent = {
      type: "model_context_prepared",
      manifest: cloneData(preparedContext.manifest),
    };
    session?.handle(contextEvent);
    yield contextEvent;
    const eventStream = modelRuntime.stream(config.model, preparedContext, {
      identity: {
        agentId: input.agentId,
        sessionId: conversationSnapshot.sessionId,
        modelCallId: preparedContext.manifest.modelCallId,
        contextSnapshotId: preparedContext.snapshotId,
        purpose: "primary",
      },
      cache: { retention: "default" },
      signal,
    });
    let promptDispatchObserved = false;

    for await (const event of eventStream) {
      if (!promptDispatchObserved) {
        loopProtection.markPromptDispatched(promptLease.id);
        promptDispatchObserved = true;
      }
      throwIfAborted(signal);
      if (event.type === "text_delta") {
        const agentEvent: AgentEvent = { type: "text_delta", delta: event.delta };
        session?.handle({ type: "text_delta", delta: event.delta });
        yield agentEvent;
      }
      if (event.type === "cache_report") {
        const cacheEvent: AgentEvent = {
          type: "model_cache_report",
          report: cloneData(event.report),
        };
        session?.handle(cacheEvent);
        yield cacheEvent;
      }
      if (event.type === "done") {
        assistantMessage = cloneTranscriptMessage(event.message);
      }
      if (event.type === "error") {
        const errorMsg = event.error.errorMessage ?? "LLM error";
        session?.handle({ type: "error", error: errorMsg });
        yield { type: "error", error: errorMsg };
        return;
      }
    }
    if (!promptDispatchObserved) loopProtection.markPromptDispatched(promptLease.id);
    throwIfAborted(signal);

    if (!assistantMessage) {
      session?.handle({ type: "error", error: "No response from LLM" });
      yield { type: "error", error: "No response from LLM" };
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
    lastUsage = toTokenUsage(assistantMessage.usage, estimatedInputTokens, contextWindow);

    // Check stop reason
    if (assistantMessage.stopReason !== "toolUse") {
      session?.handle({ type: "done", usage: lastUsage });
      yield { type: "done", produced: conversation.produced(), usage: lastUsage };
      return;
    }

    // Extract and execute tool calls
    const toolCalls = assistantMessage.content.filter(
      (block): block is ToolCallContent => block.type === "toolCall",
    );
    loopProtection.beginToolBatch(toolCalls);
    const toolResultMessages: TranscriptMessage[] = [];

    for (const call of toolCalls) {
      throwIfAborted(signal);

      let result: import("./types").ToolResult | undefined;
      for await (const event of toolCallCoordinator.run(
        config.tools,
        { toolName: call.name, toolCallId: call.id, input: call.arguments, signal },
        {
          agentId: input.agentId,
          cwd: input.cwd,
          middleware: config.middleware ?? [],
          lifecycleAdapters: config.toolLifecycleAdapters ?? [],
        },
      )) {
        if (event.type === "tool_start") {
          session?.handle({
            type: "tool_use_start",
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            input: event.input,
          });
        } else if (event.type === "tool_end") {
          result = event.result;
          session?.handle({
            type: "tool_use_end",
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            result: event.result,
            durationMs: event.durationMs,
          });
        } else {
          session?.handle(event);
        }
        yield event;
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
        isError: result.isError,
        timestamp: Date.now(),
      };
      toolResultMessages.push(toolResultMsg);
    }

    const loopDecision = loopProtection.completeToolBatch();
    for (const message of toolResultMessages) conversation.append(message);
    if (loopDecision.type === "halt") {
      session?.handle({ type: "error", error: loopDecision.error });
      yield {
        type: "error",
        error: loopDecision.error,
        code: "tool_loop_detected",
        loop: loopDecision.diagnostic,
        produced: conversation.produced(),
        usage: lastUsage,
      };
      return;
    }

    // Continue loop for next LLM turn
  }

  if (maxTurns !== undefined) {
    const error = `Max turns reached (${maxTurns})`;
    session?.handle({ type: "error", error });
    yield {
      type: "error",
      error,
      code: "max_turns_reached",
      produced: conversation.produced(),
      usage: lastUsage,
      turnCount: maxTurns,
      maxTurns,
    };
  }
}
