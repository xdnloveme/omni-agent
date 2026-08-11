import type { AgentMessage } from "../models/messages";
import type { AgentConfig, ToolResult } from "../types";
import type { AuthorizedExecutionContext } from "../execution";

export interface RunMiddleware {
  beforeModel?(config: AgentConfig, messages: readonly AgentMessage[]): void | Promise<void>;
  afterModel?(config: AgentConfig, messages: readonly AgentMessage[]): void | Promise<void>;
}

export interface ToolExecutionMiddleware {
  beforeExecute?(context: AuthorizedExecutionContext): void | Promise<void>;
  afterExecute?(context: AuthorizedExecutionContext, result: ToolResult): void | Promise<void>;
}

export type RuntimeMiddleware = RunMiddleware & ToolExecutionMiddleware;
