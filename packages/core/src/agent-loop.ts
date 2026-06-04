import type { AssistantMessage, Message } from "@mariozechner/pi-ai";

import { streamLLM } from "./llm.js";
import type { AgentConfig, AgentEvent, AgentTool } from "./types.js";

const DEFAULT_MAX_TURNS = 10;

/**
 * Run the agent loop as an async generator.
 * Yields AgentEvent as the loop progresses.
 */
export async function* runAgentLoop(
  config: AgentConfig,
  userMessage: string,
  signal?: AbortSignal,
): AsyncGenerator<AgentEvent> {
  const maxTurns = config.maxTurns ?? DEFAULT_MAX_TURNS;
  const messages: Message[] = [
    { role: "user", content: userMessage, timestamp: Date.now() },
  ];

  for (let turn = 0; turn < maxTurns; turn++) {
    if (signal?.aborted) {
      yield { type: "error", error: "Aborted" };
      return;
    }

    // Call LLM
    let assistantMessage: AssistantMessage | null = null;

    const eventStream = streamLLM(config, messages, signal);

    for await (const event of eventStream) {
      if (event.type === "text_delta") {
        yield { type: "text_delta", delta: event.delta };
      }
      if (event.type === "done") {
        assistantMessage = event.message;
      }
      if (event.type === "error") {
        yield { type: "error", error: event.error.errorMessage ?? "LLM error" };
        return;
      }
    }

    if (!assistantMessage) {
      yield { type: "error", error: "No response from LLM" };
      return;
    }

    // Push assistant message to conversation
    messages.push(assistantMessage);

    // Check stop reason
    if (assistantMessage.stopReason !== "toolUse") {
      yield { type: "done" };
      return;
    }

    // Extract and execute tool calls
    const toolCalls = assistantMessage.content.filter(
      (block): block is { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> } =>
        block.type === "toolCall",
    );

    for (const call of toolCalls) {
      if (signal?.aborted) {
        yield { type: "error", error: "Aborted" };
        return;
      }

      yield {
        type: "tool_start",
        toolName: call.name,
        toolCallId: call.id,
        input: call.arguments,
      };

      const startTime = Date.now();
      const tool = config.tools.find((t) => t.name === call.name);

      let result: { content: Array<{ type: "text"; text: string }>; isError: boolean };

      if (!tool) {
        result = {
          content: [{ type: "text", text: `Tool not found: ${call.name}` }],
          isError: true,
        };
      } else {
        try {
          result = await tool.execute(call.arguments, signal);
        } catch (err) {
          result = {
            content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
            isError: true,
          };
        }
      }

      const durationMs = Date.now() - startTime;
      yield {
        type: "tool_end",
        toolName: call.name,
        toolCallId: call.id,
        result,
        durationMs,
      };

      // Push tool result message
      messages.push({
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: result.content,
        isError: result.isError,
        timestamp: Date.now(),
      });
    }

    // Continue loop for next LLM turn
  }

  yield { type: "error", error: "Max turns reached" };
}
