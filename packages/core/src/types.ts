import type { ToolLifecycleAdapter } from "./tool-lifecycle";
import type { ExtensionEvent } from "./extension-events";
import type { AgentMessage } from "./models/messages";
import type { ModelRuntimePort, RuntimeModelSelection } from "./models/runtime";
import type { ToolAuthorizationDescriptor } from "./permissions";
import type { ToolExecutionContext, ToolExecutionStrategy, ToolTimeoutPolicy } from "./execution";

export interface AgentToolDefinition {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  strict?: boolean;
  timeout: ToolTimeoutPolicy;
  authorization: ToolAuthorizationDescriptor;
  execution: ToolExecutionStrategy;
  execute: (params: Record<string, unknown>, context: ToolExecutionContext) => Promise<ToolResult>;
}

export interface RegisteredAgentTool extends AgentToolDefinition {
  readonly originId: string;
  readonly toolIdentity: string;
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
  tools: RegisteredAgentTool[];
  toolLifecycleAdapters?: ToolLifecycleAdapter[];
  middleware?: readonly import("./middleware/types").RuntimeMiddleware[];
  maxTurns?: number;
}

export interface AgentLoopInput {
  config: AgentConfig;
  messages: readonly AgentMessage[];
  modelRuntime: ModelRuntimePort;
  agentId: string;
  cwd: string;
  toolCallCoordinator: import("./tool-calls/tool-call-coordinator").ToolCallCoordinator;
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
      metrics?: import("./tool-calls/types").ToolCallMetrics;
    }
  | ExtensionEvent
  | { type: "error"; error: string }
  | { type: "done"; produced?: AgentMessage[]; usage?: TokenUsage };

export type { AgentMessage };
