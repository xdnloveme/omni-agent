import { toContextMessages } from "./llm-context";
import type {
  AgentMessage,
  AssistantAgentMessage,
  ModelUsage,
  ToolCallContent,
} from "./models/messages";
import type { AgentConfig, AgentEvent, AgentLoopInput, TokenUsage } from "./types";
import type { StreamSession } from "./stream/index";
import { throwIfAborted } from "./execution";
import { createLoopProtection } from "./loop-protection";

const APPROX_CHARS_PER_TOKEN = 4;

export interface AgentLoopOptions {
  /** Optional StreamSession for state-machine-driven event dispatch */
  session?: StreamSession;
}

function textContentLength(content: AgentMessage["content"]): number {
  if (typeof content === "string") return content.length;
  return content.reduce((total, block) => {
    if (block.type === "text") return total + block.text.length;
    if (block.type === "thinking") return total + block.thinking.length;
    if (block.type === "toolCall")
      return total + block.name.length + JSON.stringify(block.arguments).length;
    if (block.type === "image") return total + 256;
    return total;
  }, 0);
}

function estimateRequestInputTokens(
  systemPrompt: string,
  tools: AgentConfig["tools"],
  messages: readonly AgentMessage[],
): number {
  const systemChars = systemPrompt.length;
  const messageChars = messages.reduce(
    (total, message) => total + textContentLength(message.content),
    0,
  );
  const toolChars = JSON.stringify(
    tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.schema,
    })),
  ).length;

  return Math.ceil((systemChars + messageChars + toolChars) / APPROX_CHARS_PER_TOKEN);
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
 * The caller provides the full conversation history (messages[]).
 * The loop appends assistant and tool_result messages internally and
 * yields them back via the `produced` field on the final "done" event.
 *
 * When a StreamSession is provided via options, events are also dispatched
 * through the session's state machine, enabling callback-driven consumers
 * (TUI, harness, test mocks) without coupling to the generator protocol.
 */
export async function* runAgentLoop(input: AgentLoopInput): AsyncGenerator<AgentEvent> {
  const { config, messages, modelRuntime, signal, options } = input;
  const maxTurns = config.maxTurns;
  const session = options?.session;
  const loopProtection = createLoopProtection();

  // Work on a mutable copy so we don't mutate the caller's array
  const conversation: AgentMessage[] = [...messages];
  // Track messages produced during this run
  const produced: AgentMessage[] = [];
  // Track the latest usage from the last LLM response
  let lastUsage: TokenUsage | undefined;
  const contextWindow = config.model.contextWindow;
  const toolCallCoordinator = input.toolCallCoordinator;

  for (let turn = 0; maxTurns === undefined || turn < maxTurns; turn++) {
    throwIfAborted(signal);

    // Call LLM
    let assistantMessage: AssistantAgentMessage | null = null;

    for (const middleware of config.middleware ?? []) {
      await middleware.beforeModel?.(config, conversation);
    }
    throwIfAborted(signal);
    const promptLease = loopProtection.leaseSystemPrompt(
      config.systemPrompt,
      config.tools.length > 0,
    );
    const estimatedInputTokens = estimateRequestInputTokens(
      promptLease.systemPrompt,
      config.tools,
      conversation,
    );
    const eventStream = modelRuntime.stream(
      config.model,
      {
        systemPrompt: promptLease.systemPrompt,
        messages: toContextMessages(conversation),
        tools: config.tools,
      },
      { signal },
    );
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
      if (event.type === "done") {
        assistantMessage = event.message;
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

    // Push assistant message to conversation
    conversation.push(assistantMessage);
    produced.push(assistantMessage);
    for (const middleware of config.middleware ?? []) {
      await middleware.afterModel?.(config, conversation);
    }
    throwIfAborted(signal);

    // Extract usage from the assistant message. Context occupancy includes cached prompt
    // tokens; provider usage may report those separately from fresh input tokens.
    lastUsage = toTokenUsage(assistantMessage.usage, estimatedInputTokens, contextWindow);

    // Check stop reason
    if (assistantMessage.stopReason !== "toolUse") {
      session?.handle({ type: "done", usage: lastUsage });
      yield { type: "done", produced, usage: lastUsage };
      return;
    }

    // Extract and execute tool calls
    const toolCalls = assistantMessage.content.filter(
      (block): block is ToolCallContent => block.type === "toolCall",
    );
    loopProtection.beginToolBatch(toolCalls);
    const toolResultMessages: AgentMessage[] = [];

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
      const toolResultMsg: AgentMessage = {
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
    conversation.push(...toolResultMessages);
    produced.push(...toolResultMessages);
    if (loopDecision.type === "halt") {
      session?.handle({ type: "error", error: loopDecision.error });
      yield {
        type: "error",
        error: loopDecision.error,
        code: "tool_loop_detected",
        loop: loopDecision.diagnostic,
        produced,
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
      produced,
      usage: lastUsage,
      turnCount: maxTurns,
      maxTurns,
    };
  }
}
