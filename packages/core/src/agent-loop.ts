import type { AssistantMessage, Message } from "@mariozechner/pi-ai";

import { streamLLM } from "./llm";
import { getDefaultContextWindow } from "./llm";
import type { AgentConfig, AgentEvent, TokenUsage } from "./types";
import type { StreamSession } from "./stream/index";
import { collectLifecycleEndEvents, collectLifecycleStartEvents } from "./tool-lifecycle";
import { ToolExecutor } from "./tools/executor";

const DEFAULT_MAX_TURNS = 10;
const APPROX_CHARS_PER_TOKEN = 4;

export interface AgentLoopOptions {
  /** Optional StreamSession for state-machine-driven event dispatch */
  session?: StreamSession;
}

/**
 * Result messages produced by the agent loop during execution.
 * These are the assistant + tool_result messages generated in this run.
 */
export interface AgentLoopResult {
  messages: Message[];
}

function textContentLength(content: Message["content"]): number {
  if (typeof content === "string") return content.length;
  return content.reduce((total, block) => {
    if (block.type === "text") return total + block.text.length;
    if (block.type === "thinking") return total + block.thinking.length;
    if (block.type === "toolCall") return total + block.name.length + JSON.stringify(block.arguments).length;
    if (block.type === "image") return total + 256;
    return total;
  }, 0);
}

function estimateRequestInputTokens(config: AgentConfig, messages: Message[]): number {
  const systemChars = config.systemPrompt.length;
  const messageChars = messages.reduce((total, message) => total + textContentLength(message.content), 0);
  const toolChars = JSON.stringify(
    config.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.schema,
    })),
  ).length;

  return Math.ceil((systemChars + messageChars + toolChars) / APPROX_CHARS_PER_TOKEN);
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
export async function* runAgentLoop(
  config: AgentConfig,
  messages: Message[],
  signal?: AbortSignal,
  options?: AgentLoopOptions,
): AsyncGenerator<AgentEvent> {
  const maxTurns = config.maxTurns ?? DEFAULT_MAX_TURNS;
  const session = options?.session;

  // Work on a mutable copy so we don't mutate the caller's array
  const conversation: Message[] = [...messages];
  // Track messages produced during this run
  const produced: Message[] = [];
  // Track the latest usage from the last LLM response
  let lastUsage: TokenUsage | undefined;
  const contextWindow = config.contextWindow ?? getDefaultContextWindow(config.provider);
  const toolExecutor = new ToolExecutor();

  for (let turn = 0; turn < maxTurns; turn++) {
    if (signal?.aborted) {
      const event: AgentEvent = { type: "error", error: "Aborted" };
      session?.handle({ type: "error", error: "Aborted" });
      yield event;
      return;
    }

    // Call LLM
    let assistantMessage: AssistantMessage | null = null;

    const estimatedInputTokens = estimateRequestInputTokens(config, conversation);
    const eventStream = streamLLM(config, conversation, signal);

    for await (const event of eventStream) {
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

    if (!assistantMessage) {
      session?.handle({ type: "error", error: "No response from LLM" });
      yield { type: "error", error: "No response from LLM" };
      return;
    }

    // Push assistant message to conversation
    conversation.push(assistantMessage);
    produced.push(assistantMessage);

    // Extract usage from the assistant message. Context occupancy includes cached prompt
    // tokens; provider usage may report those separately from fresh input tokens.
    if (assistantMessage.usage) {
      const reportedInputTokens =
        assistantMessage.usage.input + assistantMessage.usage.cacheRead + assistantMessage.usage.cacheWrite;
      const inputTokens = Math.max(reportedInputTokens, estimatedInputTokens);
      lastUsage = {
        inputTokens,
        outputTokens: assistantMessage.usage.output,
        totalTokens: inputTokens + assistantMessage.usage.output,
        contextWindow,
        estimated: inputTokens !== reportedInputTokens,
      };
    } else {
      lastUsage = {
        inputTokens: estimatedInputTokens,
        outputTokens: 0,
        totalTokens: estimatedInputTokens,
        contextWindow,
        estimated: true,
      };
    }

    // Check stop reason
    if (assistantMessage.stopReason !== "toolUse") {
      session?.handle({ type: "done", usage: lastUsage });
      yield { type: "done", produced, usage: lastUsage };
      return;
    }

    // Extract and execute tool calls
    const toolCalls = assistantMessage.content.filter(
      (block): block is { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> } =>
        block.type === "toolCall",
    );

    for (const call of toolCalls) {
      if (signal?.aborted) {
        session?.handle({ type: "error", error: "Aborted" });
        yield { type: "error", error: "Aborted" };
        return;
      }

      session?.handle({
        type: "tool_use_start",
        toolName: call.name,
        toolCallId: call.id,
        input: call.arguments,
      });
      yield {
        type: "tool_start",
        toolName: call.name,
        toolCallId: call.id,
        input: call.arguments,
      };

      const lifecycleStartEvents = collectLifecycleStartEvents(config.toolLifecycleAdapters, {
        toolName: call.name,
        toolCallId: call.id,
        input: call.arguments,
      });
      for (const event of lifecycleStartEvents) {
        session?.handle(event);
        yield event;
      }

      const execution = await toolExecutor.execute(config.tools, call.name, call.arguments, signal);
      const { result, durationMs } = execution;
      session?.handle({
        type: "tool_use_end",
        toolName: call.name,
        toolCallId: call.id,
        result,
        durationMs,
      });
      yield {
        type: "tool_end",
        toolName: call.name,
        toolCallId: call.id,
        result,
        durationMs,
      };

      const lifecycleEndEvents = collectLifecycleEndEvents(config.toolLifecycleAdapters, {
        toolName: call.name,
        toolCallId: call.id,
        input: call.arguments,
        result,
        durationMs,
      });
      for (const event of lifecycleEndEvents) {
        session?.handle(event);
        yield event;
      }

      // Push tool result message
      const toolResultMsg: Message = {
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: result.content,
        isError: result.isError,
        timestamp: Date.now(),
      };
      conversation.push(toolResultMsg);
      produced.push(toolResultMsg);
    }

    // Continue loop for next LLM turn
  }

  session?.handle({ type: "error", error: "Max turns reached" });
  yield { type: "error", error: "Max turns reached" };
}
