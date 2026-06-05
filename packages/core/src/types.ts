import type { AssistantMessageEvent, Message } from "@mariozechner/pi-ai";

export interface AgentTool {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  execute: (
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<ToolResult>;
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
}

/** Token usage information from the LLM response */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  contextWindow: number;
}

export interface AgentConfig {
  model: string;
  apiKey: string;
  endpoint?: string;
  provider?: "anthropic" | "kimi" | "custom";
  systemPrompt: string;
  tools: AgentTool[];
  maxTurns?: number;
  maxTokens?: number;
  contextWindow?: number;
}

// Events emitted by the agent loop
export type AgentEvent =
  | { type: "text_delta"; delta: string }
  | { type: "tool_start"; toolName: string; toolCallId: string; input: Record<string, unknown> }
  | { type: "tool_end"; toolName: string; toolCallId: string; result: ToolResult; durationMs: number }
  | { type: "error"; error: string }
  | { type: "done"; produced?: Message[]; usage?: TokenUsage };

export type { Message, AssistantMessageEvent };
