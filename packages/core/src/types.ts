import type { ToolLifecycleAdapter } from "./tool-lifecycle";
import type { ExtensionEvent } from "./extension-events";
import type { AgentMessage } from "./models/messages";
import type { ModelRuntimePort, RuntimeModelSelection } from "./models/runtime";

export interface AgentTool {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  strict?: boolean;
  risk?: "read" | "write" | "execute" | "network";
  approval?: "never" | "always" | "policy";
  timeoutMs?: number;
  execute: (params: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolResult>;
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
  model: RuntimeModelSelection;
  systemPrompt: string;
  tools: AgentTool[];
  toolLifecycleAdapters?: ToolLifecycleAdapter[];
  middleware?: readonly import("./middleware/types").RuntimeMiddleware[];
  maxTurns?: number;
}

export interface AgentLoopInput {
  config: AgentConfig;
  messages: readonly AgentMessage[];
  modelRuntime: ModelRuntimePort;
  toolExecutor?: import("./tools/executor").ToolExecutor;
  signal?: AbortSignal;
  options?: import("./agent-loop").AgentLoopOptions;
}

// Events emitted by the agent loop
export type AgentEvent =
  | { type: "text_delta"; delta: string }
  | { type: "tool_start"; toolName: string; toolCallId: string; input: Record<string, unknown> }
  | {
      type: "tool_end";
      toolName: string;
      toolCallId: string;
      result: ToolResult;
      durationMs: number;
    }
  | ExtensionEvent
  | { type: "error"; error: string }
  | { type: "done"; produced?: AgentMessage[]; usage?: TokenUsage };

export type { AgentMessage };
