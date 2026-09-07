import type { ToolLifecycleAdapter } from "./tool-lifecycle";
import type { ToolLoopDiagnostic } from "./loop-protection";
import type { ExtensionEvent } from "./extension-events";
import type { ModelRuntimePort, RuntimeModelSelection } from "./models/runtime";
import type { ModelCacheReport } from "./models/cache";
import type { ToolAccessDescriptor } from "./access";
import type {
  ProcessInvocation,
  ProcessResult,
  ToolExecutionContext,
  ToolExecutionStrategy,
  ToolTimeoutPolicy,
} from "./execution";
import type { ToolPreflightDescriptor } from "./tool-calls/tool-preflight";
import type {
  ContextEnginePort,
  ContextMiddlewarePort,
  ModelContextSnapshotManifest,
  ContextProgressEvent,
} from "./context";
import type { SessionRecord, SessionSnapshot } from "./session";
import type { RuntimeRunObservation } from "./runtime-observation";

interface AgentToolDefinitionBase {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  strict?: boolean;
  preflight?: ToolPreflightDescriptor;
  timeout: ToolTimeoutPolicy;
  access: ToolAccessDescriptor;
  execution: ToolExecutionStrategy;
  invocation?: ToolInvocationPresentation;
  scheduling?: ToolSchedulingPolicy;
  context?: ToolContextPolicy;
}

export interface InProcessToolDefinition extends AgentToolDefinitionBase {
  execution: { kind: "in_process" };
  execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult>;
}

export interface ProcessToolDefinition extends AgentToolDefinitionBase {
  execution: { kind: "process" };
  /** Pure, bounded planning step. Must not spawn a process or perform external I/O. */
  createProcessInvocation(
    params: Record<string, unknown>,
    context: ToolExecutionContext,
  ): ProcessInvocation | Promise<ProcessInvocation>;
  createToolResult(
    result: ProcessResult,
    params: Readonly<Record<string, unknown>>,
    context: ToolExecutionContext,
  ): ToolResult | Promise<ToolResult>;
}

export type AgentToolDefinition = InProcessToolDefinition | ProcessToolDefinition;

export interface ToolSchedulingPolicy {
  readonly batch: "normal" | "turn_barrier";
}

export interface ToolContextPolicy {
  readonly retention: "default" | "conversation";
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

export type RegisteredAgentTool = AgentToolDefinition & {
  readonly originId: string;
  readonly toolIdentity: string;
};

export function isInProcessTool(
  tool: AgentToolDefinition | RegisteredAgentTool,
): tool is InProcessToolDefinition & Partial<RegisteredAgentTool> {
  return tool.execution.kind === "in_process";
}

export function isProcessTool(
  tool: AgentToolDefinition | RegisteredAgentTool,
): tool is ProcessToolDefinition & Partial<RegisteredAgentTool> {
  return tool.execution.kind === "process";
}

export type ToolResultContent =
  | { type: "text"; text: string; annotations?: ToolContentAnnotations }
  | {
      type: "image";
      data: string;
      mimeType: string;
      annotations?: ToolContentAnnotations;
      text?: undefined;
    }
  | {
      type: "audio";
      data: string;
      mimeType: string;
      annotations?: ToolContentAnnotations;
      text?: undefined;
    }
  | {
      type: "resource_link";
      name: string;
      uri: string;
      title?: string;
      description?: string;
      mimeType?: string;
      size?: number;
      annotations?: ToolContentAnnotations;
      text?: undefined;
    }
  | {
      type: "resource";
      resource:
        | { uri: string; mimeType?: string; text: string }
        | { uri: string; mimeType?: string; blob: string };
      annotations?: ToolContentAnnotations;
      text?: undefined;
    };

export interface ToolContentAnnotations {
  readonly audience?: readonly ("user" | "assistant")[];
  readonly priority?: number;
  readonly lastModified?: string;
}

export interface ToolResult {
  content: ToolResultContent[];
  structuredContent?: import("./data").JsonValue;
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
  usableInputBudget: number;
  requestedOutputTokens: number;
  estimated?: boolean;
}

export interface AgentConfig {
  model: RuntimeModelSelection;
  systemPrompt: string;
  tools: RegisteredAgentTool[];
  toolLifecycleAdapters?: ToolLifecycleAdapter[];
  middleware?: readonly import("./middleware/types").RuntimeMiddleware[];
  maxTurns?: number;
  toolBatchPreparationPolicies?: readonly import("./tool-calls").ToolBatchPreparationPolicy[];
  hooks?: readonly import("./hooks").PostEventHook[];
  onHookDiagnostic?: (value: import("./hooks").HookDiagnostic) => void;
}

export interface AgentFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly field?: string;
}

export interface AgentLoopInput {
  config: AgentConfig;
  snapshot: SessionSnapshot;
  contextEngine: ContextEnginePort;
  contextMiddleware: readonly ContextMiddlewarePort[];
  modelRuntime: ModelRuntimePort;
  agentId: string;
  workspaceId: string;
  workspaceRoot: string;
  environmentContext: import("./environment").EnvironmentContextControllerPort;
  toolCallCoordinator: import("./tool-calls/tool-call-coordinator").ToolCallCoordinator;
  observation?: RuntimeRunObservation;
  signal?: AbortSignal;
  options?: import("./agent-loop").AgentLoopOptions;
}

// Events emitted by the agent loop
export type AgentEvent =
  | { type: "text_delta"; modelCallId: string; textSegmentId: string; delta: string }
  | { type: "final_response"; modelCallId: string }
  | { type: "thinking_start"; modelCallId: string; contentIndex: number }
  | {
      type: "thinking_delta";
      modelCallId: string;
      contentIndex: number;
      delta: string;
    }
  | {
      type: "thinking_end";
      modelCallId: string;
      contentIndex: number;
      content: string;
    }
  | { type: "model_context_prepared"; manifest: ModelContextSnapshotManifest }
  | { type: "model_cache_report"; report: ModelCacheReport }
  | { type: "context_progress"; event: ContextProgressEvent }
  | { type: "tool_batch_started"; batch: ToolBatchDescriptor }
  | {
      type: "tool_batch_deferred";
      batchId: string;
      code: string;
      retryable: true;
    }
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
      failure: AgentFailure;
      produced?: readonly SessionRecord[];
      usage?: TokenUsage;
      turnCount?: number;
      maxTurns?: number;
      loop?: ToolLoopDiagnostic;
    }
  | { type: "done"; produced?: readonly SessionRecord[]; usage?: TokenUsage };
