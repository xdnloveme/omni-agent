import type { ToolExecutionContext } from "../execution";
import type { ToolResult } from "../types";

export type ToolPreflightResult = { outcome: "ready" } | { outcome: "error"; result: ToolResult };

export interface ToolPreflightDescriptor {
  validate(
    input: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolPreflightResult>;
}
