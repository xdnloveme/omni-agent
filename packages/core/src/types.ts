import type { ToolLifecycleAdapter } from "./tool-lifecycle";
import type { ToolLoopDiagnostic } from "./loop-protection";
import type { ExtensionEvent } from "./extension-events";
import type { TranscriptMessage } from "./messages";
import type { ModelRuntimePort, RuntimeModelSelection } from "./models/runtime";
import type { ModelCacheReport } from "./models/cache";
import type { ToolAuthorizationDescriptor } from "./permissions";
import type { ToolExecutionContext, ToolExecutionStrategy, ToolTimeoutPolicy } from "./execution";
import type { ToolPreflightDescriptor } from "./tool-calls/tool-preflight";
import type {
  ContextEnginePort,
  ContextMiddlewarePort,
  ModelContextSnapshotManifest,
  ContextProgressEvent,
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
  invocation?: ToolInvocationPresentation;
  execute: (params: Record<string, unknown>, context: ToolExecutionContext) => Promise<ToolResult>;
}

export type ToolInvocationAction =
  "invoke" | "execute" | "read" | "edit" | "write" | "search" | "fetch";

export type ToolInvocationResourceKind = "file" | "command" | "url" | "text";

export interface ToolInvocationPresentation {
  readonly action: ToolInvocationAction;
  readonly resource?: {
    readonly kind: ToolInvocationResourceKind;
    readonly inputKey: string;
  };
}

export interface ToolInvocationPreview {
  readonly action: ToolInvocationAction;
  readonly resource?: {
    readonly kind: ToolInvocationResourceKind;
    readonly value: string;
  };
}

export interface ToolBatchPosition {
  readonly batchId: string;
  readonly index: number;
  readonly total: number;
}

export interface ToolBatchMember {
  readonly toolName: string;
  readonly toolCallId: string;
  readonly preview: ToolInvocationPreview;
}

export interface ToolBatchDescriptor {
  readonly batchId: string;
  readonly modelCallId: string;
  readonly members: readonly ToolBatchMember[];
}

export interface RegisteredAgentTool extends AgentToolDefinition {
  readonly originId: string;
  readonly toolIdentity: string;
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
  meta?: ToolResultMetadata;
}

export interface ToolResourceReference {
  readonly kind: "file";
  readonly path: string;
}

export interface ToolResultPresentationData {
  readonly resource?: ToolResourceReference;
}

export interface ToolResultMetadata extends Record<string, unknown> {
  readonly presentation?: ToolResultPresentationData;
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
  | { type: "model_cache_report"; report: ModelCacheReport }
  | { type: "context_progress"; event: ContextProgressEvent }
  | { type: "tool_batch_started"; batch: ToolBatchDescriptor }
  | {
      type: "tool_start";
      toolName: string;
      toolCallId: string;
      input: Record<string, unknown>;
      preview: ToolInvocationPreview;
      batch: ToolBatchPosition;
    }
  | {
      type: "tool_end";
      toolName: string;
      toolCallId: string;
      result: ToolResult;
      durationMs: number;
      batch: ToolBatchPosition;
      metrics?: import("./tool-calls/types").ToolCallMetrics;
    }
  | {
      type: "tool_batch_completed";
      batchId: string;
      modelCallId: string;
      durationMs: number;
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
