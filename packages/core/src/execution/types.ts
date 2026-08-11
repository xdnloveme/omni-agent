import type { RegisteredAgentTool, ToolResult } from "../types";

export interface ToolExecutionContext {
  cwd: string;
  signal?: AbortSignal;
}

export type ToolExecutionStrategy =
  { kind: "host" } | { kind: "sandbox_eligible"; profile: string };

export interface AuthorizedExecutionContext extends ToolExecutionContext {
  toolName: string;
  input: Readonly<Record<string, unknown>>;
}

declare const authorizedToolCallBrand: unique symbol;

export interface AuthorizedToolCall {
  readonly [authorizedToolCallBrand]: true;
  readonly tool: RegisteredAgentTool;
  readonly input: Readonly<Record<string, unknown>>;
  readonly context: ToolExecutionContext;
}

export interface ToolInvocationResult {
  result: ToolResult;
  executionMs: number;
}

export interface SandboxExecutionRequest {
  tool: RegisteredAgentTool;
  input: Readonly<Record<string, unknown>>;
  context: ToolExecutionContext;
  profile: string;
}

export interface SandboxRunnerPort {
  run(request: SandboxExecutionRequest): Promise<ToolResult>;
}
