import type { AssistantMessageEvent, Message } from "@mariozechner/pi-ai";
import type { ToolLifecycleAdapter } from "./tool-lifecycle";
import type { ExtensionEvent } from "./extension-events";
import type { ProviderId } from "./models";

export interface AgentTool {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  strict?: boolean;
  risk?: "read" | "write" | "execute" | "network";
  approval?: "never" | "always" | "policy";
  timeoutMs?: number;
  execute: (
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<ToolResult>;
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
  meta?: Record<string, unknown>;
}

/** Token usage information from the LLM response */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  contextWindow: number;
  estimated?: boolean;
}

export interface AgentConfig {
  model: string;
  apiKey: string;
  endpoint?: string;
  provider?: ProviderId;
  systemPrompt: string;
  tools: AgentTool[];
  toolLifecycleAdapters?: ToolLifecycleAdapter[];
  maxTurns?: number;
  maxTokens?: number;
  contextWindow?: number;
}

// Events emitted by the agent loop
export type AgentEvent =
  | { type: "text_delta"; delta: string }
  | { type: "tool_start"; toolName: string; toolCallId: string; input: Record<string, unknown> }
  | { type: "tool_end"; toolName: string; toolCallId: string; result: ToolResult; durationMs: number }
  | ExtensionEvent
  | { type: "error"; error: string }
  | { type: "done"; produced?: Message[]; usage?: TokenUsage };

export type { Message, AssistantMessageEvent };
