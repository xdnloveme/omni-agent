import type { AgentTool, ToolResult } from "../types";
import type { ToolGuardrail } from "./guardrail";
import type { ToolPolicy } from "./policy";

export interface ToolExecutorOptions {
  policy?: ToolPolicy;
  guardrails?: ToolGuardrail[];
}

export interface ToolExecutionResult {
  result: ToolResult;
  durationMs: number;
}

export class ToolExecutor {
  constructor(private readonly options: ToolExecutorOptions = {}) {}

  async execute(
    tools: readonly AgentTool[],
    toolName: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolExecutionResult> {
    const startedAt = Date.now();
    const tool = tools.find((candidate) => candidate.name === toolName);
    if (!tool) {
      return {
        result: this.error(`Tool not found: ${toolName}`),
        durationMs: Date.now() - startedAt,
      };
    }

    try {
      if (tool.strict) {
        const validationError = validateInput(tool.schema, input);
        if (validationError) {
          return {
            result: this.error(`Invalid tool input: ${validationError}`),
            durationMs: Date.now() - startedAt,
          };
        }
      }
      const decision = await this.options.policy?.evaluate({ tool, input });
      if (decision && !decision.allowed) {
        return {
          result: this.error(`Tool denied: ${decision.reason}`),
          durationMs: Date.now() - startedAt,
        };
      }

      const context = { toolName, input };
      for (const guardrail of this.options.guardrails ?? []) {
        await guardrail.before?.(context);
      }

      const result = await executeWithTimeout(tool, input, signal);
      for (const guardrail of this.options.guardrails ?? []) {
        await guardrail.after?.(context, result);
      }
      return { result, durationMs: Date.now() - startedAt };
    } catch (error) {
      return {
        result: this.error(error instanceof Error ? error.message : String(error)),
        durationMs: Date.now() - startedAt,
      };
    }
  }

  private error(message: string): ToolResult {
    return { content: [{ type: "text", text: message }], isError: true };
  }
}

async function executeWithTimeout(
  tool: AgentTool,
  input: Record<string, unknown>,
  parentSignal?: AbortSignal,
): Promise<ToolResult> {
  if (!tool.timeoutMs) return tool.execute(input, parentSignal);
  const controller = new AbortController();
  const onAbort = () => controller.abort(parentSignal?.reason);
  parentSignal?.addEventListener("abort", onAbort, { once: true });
  let timeout: NodeJS.Timeout | undefined;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error(`Tool timed out after ${tool.timeoutMs}ms`));
      }, tool.timeoutMs);
    });
    return await Promise.race([tool.execute(input, controller.signal), timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", onAbort);
  }
}

function validateInput(
  schema: Record<string, unknown>,
  input: Record<string, unknown>,
): string | null {
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) {
    if (typeof key === "string" && input[key] === undefined) return `${key} is required`;
  }
  const properties = schema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return null;
  for (const [key, rawProperty] of Object.entries(properties)) {
    const value = input[key];
    if (value === undefined || !rawProperty || typeof rawProperty !== "object") continue;
    const property = rawProperty as Record<string, unknown>;
    if (property.type === "string" && typeof value !== "string") return `${key} must be a string`;
    if (property.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) {
      return `${key} must be a finite number`;
    }
    if (property.type === "integer" && !Number.isInteger(value)) return `${key} must be an integer`;
    if (property.type === "array" && !Array.isArray(value)) return `${key} must be an array`;
    if (
      typeof property.minimum === "number" &&
      typeof value === "number" &&
      value < property.minimum
    ) {
      return `${key} must be >= ${property.minimum}`;
    }
  }
  return null;
}
