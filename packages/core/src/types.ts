import type { ToolLifecycleAdapter } from "./tool-lifecycle";
import type { ToolLoopDiagnostic } from "./loop-protection";
import type { ExtensionEvent } from "./extension-events";
import type { TranscriptMessage } from "./messages";
import type { ModelRuntimePort, RuntimeModelSelection } from "./models/runtime";
import type { ToolAuthorizationDescriptor } from "./permissions";
import type { ToolExecutionContext, ToolExecutionStrategy, ToolTimeoutPolicy } from "./execution";
import type { ToolPreflightDescriptor } from "./tool-calls/tool-preflight";
import type {
  ContextEnginePort,
  ContextMiddlewarePort,
  ModelContextSnapshotManifest,
} from "./context";
import type { SessionTranscriptSnapshot } from "./session";

export interface AgentToolDefinition {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  strict?: boolean;
  preflight?: ToolPreflightDescriptor;
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
  snapshot: SessionTranscriptSnapshot;
  contextEngine: ContextEnginePort;
  contextMiddleware: readonly ContextMiddlewarePort[];
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
  | { type: "model_context_prepared"; manifest: ModelContextSnapshotManifest }
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
  | {
      type: "error";
      error: string;
      code?: "max_turns_reached" | "tool_loop_detected";
      produced?: readonly TranscriptMessage[];
      usage?: TokenUsage;
      turnCount?: number;
      maxTurns?: number;
      loop?: ToolLoopDiagnostic;
    }
  | { type: "done"; produced?: readonly TranscriptMessage[]; usage?: TokenUsage };
