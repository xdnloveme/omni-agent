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

export interface AgentConfig {
  model: string;
  apiKey: string;
  endpoint?: string;
  provider?: "anthropic" | "kimi" | "custom";
  systemPrompt: string;
  tools: AgentTool[];
  maxTurns?: number;
}

// Events emitted by the agent loop
export type AgentEvent =
  | { type: "text_delta"; delta: string }
  | { type: "tool_start"; toolName: string; toolCallId: string; input: Record<string, unknown> }
  | { type: "tool_end"; toolName: string; toolCallId: string; result: ToolResult; durationMs: number }
  | { type: "error"; error: string }
  | { type: "done" };

export type { Message, AssistantMessageEvent };
