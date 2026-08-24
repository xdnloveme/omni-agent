import type { HostRuntimeContext } from "../execution";
import type { ToolResult } from "../types";

export type ToolPreflightResult = { outcome: "ready" } | { outcome: "error"; result: ToolResult };

export interface ToolPreflightContext {
  readonly cwd: string;
  readonly hostRuntime: HostRuntimeContext;
  readonly signal?: AbortSignal;
}

export interface ToolPreflightDescriptor {
  validate(
    input: Record<string, unknown>,
    context: ToolPreflightContext,
  ): Promise<ToolPreflightResult>;
}
