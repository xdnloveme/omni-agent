import type { ToolExecutionMiddleware } from "../middleware";
import type { ToolResult } from "../types";
import { isAbortError, throwIfAborted } from "./abort";
import {
  ExecutionDeadlineSupervisor,
  type ExecutionDeadlineSupervisorOptions,
} from "./execution-deadline-supervisor";
import { resolveToolTimeout } from "./timeout-policy";
import { ToolTimeoutError } from "./tool-timeout-error";
import type {
  AuthorizedExecutionContext,
  AuthorizedToolCall,
  SandboxRunnerPort,
  ToolInvocationResult,
} from "./types";

export type { LateToolSettlementEvent } from "./execution-deadline-supervisor";

export interface ToolInvocationRunnerOptions extends ExecutionDeadlineSupervisorOptions {
  sandboxRunner?: SandboxRunnerPort;
}

export class ToolInvocationRunner {
  private readonly deadlineSupervisor: ExecutionDeadlineSupervisor;

  constructor(private readonly options: ToolInvocationRunnerOptions = {}) {
    this.deadlineSupervisor = new ExecutionDeadlineSupervisor(options);
  }

  async invoke(
    call: AuthorizedToolCall,
    middleware: readonly ToolExecutionMiddleware[],
  ): Promise<ToolInvocationResult> {
    const executionStartedAt = Date.now();
    const executionContext: AuthorizedExecutionContext = {
      toolName: call.tool.name,
      input: call.input,
      ...call.context,
    };
    try {
      throwIfAborted(call.context.signal);
      for (const entry of middleware) await entry.beforeExecute?.(executionContext);
      throwIfAborted(call.context.signal);
      const result = await this.executeAuthorized(call);
      throwIfAborted(call.context.signal);
      for (const entry of middleware) await entry.afterExecute?.(executionContext, result);
      throwIfAborted(call.context.signal);
      return { result, executionMs: Date.now() - executionStartedAt };
    } catch (error) {
      if (isAbortError(error, call.context.signal)) throw error;
      return {
        result:
          error instanceof ToolTimeoutError
            ? timeoutResult(error)
            : toolError(error instanceof Error ? error.message : String(error)),
        executionMs: Date.now() - executionStartedAt,
      };
    }
  }

  private async executeAuthorized(call: AuthorizedToolCall): Promise<ToolResult> {
    const timeoutMs = resolveToolTimeout(call.tool.timeout, call.input);
    return this.deadlineSupervisor.run({
      toolName: call.tool.name,
      timeoutMs,
      externalSignal: call.context.signal,
      execute: (signal) => this.startExecution(call, signal),
    });
  }

  private startExecution(call: AuthorizedToolCall, signal: AbortSignal): Promise<ToolResult> {
    const request = {
      tool: call.tool,
      input: call.input,
      context: { cwd: call.context.cwd, signal },
    };
    return call.tool.execution.kind === "sandbox_eligible" && this.options.sandboxRunner
      ? this.options.sandboxRunner.run({
          ...request,
          profile: call.tool.execution.profile,
        })
      : call.tool.execute(request.input, request.context);
  }
}

function timeoutResult(error: ToolTimeoutError): ToolResult {
  return {
    content: [{ type: "text", text: error.message }],
    isError: true,
    meta: { code: error.code, timeoutMs: error.timeoutMs, retryable: true },
  };
}

function toolError(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}
