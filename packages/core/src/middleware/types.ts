import type { DeepReadonly } from "../data";
import type { ModelCallCompletedContext } from "../context";
import type { ToolResult } from "../types";
import type { AuthorizedExecutionContext } from "../execution";

export interface RunMiddleware {
  afterModel?(context: DeepReadonly<ModelCallCompletedContext>): void | Promise<void>;
}

export interface ToolExecutionMiddleware {
  beforeExecute?(context: AuthorizedExecutionContext): void | Promise<void>;
  /** Reordering/cloning a preview or page preserves its block-local outputSource.
   * Independent replacement content must omit that source; a new preview must declare its own.
   * Core consumes these runtime fields after middleware, before persistence/model projection.
   */
  afterExecute?(context: AuthorizedExecutionContext, result: ToolResult): void | Promise<void>;
}

export type RuntimeMiddleware = RunMiddleware & ToolExecutionMiddleware;
