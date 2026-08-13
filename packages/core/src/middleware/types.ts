import type { DeepReadonly } from "../data";
import type { ModelCallCompletedContext } from "../context";
import type { ToolResult } from "../types";
import type { AuthorizedExecutionContext } from "../execution";

export interface RunMiddleware {
  afterModel?(context: DeepReadonly<ModelCallCompletedContext>): void | Promise<void>;
}

export interface ToolExecutionMiddleware {
  beforeExecute?(context: AuthorizedExecutionContext): void | Promise<void>;
  afterExecute?(context: AuthorizedExecutionContext, result: ToolResult): void | Promise<void>;
}

export type RuntimeMiddleware = RunMiddleware & ToolExecutionMiddleware;
