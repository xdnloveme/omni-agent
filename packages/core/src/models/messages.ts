export interface TextContent {
  type: "text";
  text: string;
  textSignature?: string;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
  redacted?: boolean;
}

export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface ToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  thoughtSignature?: string;
}

export interface ModelUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
  totalTokens?: number;
  cost?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export interface ModelDiagnostic {
  type: string;
  timestamp: number;
  error?: {
    name?: string;
    message: string;
    stack?: string;
    code?: string | number;
  };
  details?: Record<string, unknown>;
}

export interface DeferredModelResponse {
  provider: string;
  modelId: string;
  api: string;
  id: string;
  expiresAt?: number;
  pollAfterMs?: number;
  data?: import("./runtime").JsonValue;
}

export interface UserAgentMessage {
  role: "user";
  content: string | Array<TextContent | ImageContent>;
  timestamp: number;
}

export interface AssistantAgentMessage {
  role: "assistant";
  content: Array<TextContent | ThinkingContent | ToolCallContent>;
  api: string;
  provider: string;
  model: string;
  responseModel?: string;
  stopReason: "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";
  usage: ModelUsage;
  timestamp: number;
  responseId?: string;
  diagnostics?: ModelDiagnostic[];
  deferred?: DeferredModelResponse;
  errorMessage?: string;
  rawStopReason?: string;
}

export interface ToolResultAgentMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: Array<TextContent | ImageContent>;
  details?: unknown;
  usage?: ModelUsage;
  addedToolNames?: string[];
  isError: boolean;
  timestamp: number;
}

export type AgentMessage = UserAgentMessage | AssistantAgentMessage | ToolResultAgentMessage;
