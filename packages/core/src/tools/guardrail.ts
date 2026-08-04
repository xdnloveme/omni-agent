import type { ToolResult } from "../types";

export interface ToolGuardrailContext {
  toolName: string;
  input: Record<string, unknown>;
}

export interface ToolGuardrail {
  before?(context: ToolGuardrailContext): void | Promise<void>;
  after?(context: ToolGuardrailContext, result: ToolResult): void | Promise<void>;
}
