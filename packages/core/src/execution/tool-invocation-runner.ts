import type { ToolExecutionMiddleware } from "../middleware";
import type { ToolResult } from "../types";
import { redactExactSensitiveValue } from "../security";
import { isAbortError, throwIfAborted } from "./abort";
import {
  OperationDeadlineSupervisor,
  type OperationDeadlineSupervisorOptions,
} from "./operation-deadline-supervisor";
import { resolveToolTimeout } from "./timeout-policy";
import { ToolTimeoutError } from "./tool-timeout-error";
import type {
  AuthorizedExecutionContext,
  AuthorizedToolCall,
  ProcessExecutionRouterPort,
  ToolInvocationResult,
} from "./types";
import { isInProcessTool } from "../types";
import {
  NOOP_RUNTIME_EXECUTION_OBSERVATION,
  type RuntimeExecutionObservation,
} from "../runtime-observation";

export interface LateToolSettlementEvent {
  toolName: string;
  outcome: "fulfilled" | "rejected";
  error?: unknown;
}

export interface ToolInvocationRunnerOptions {
  processRouter: ProcessExecutionRouterPort;
  cleanupGraceMs?: OperationDeadlineSupervisorOptions["cleanupGraceMs"];
  onLateSettlement?: (event: LateToolSettlementEvent) => void | Promise<void>;
}

export class ToolInvocationRunner {
  private readonly deadlineSupervisor: OperationDeadlineSupervisor;

  constructor(private readonly options: ToolInvocationRunnerOptions) {
    this.deadlineSupervisor = new OperationDeadlineSupervisor({
      cleanupGraceMs: options.cleanupGraceMs,
      onLateSettlement: (event) =>
        options.onLateSettlement?.({
          toolName: event.operationName,
          outcome: event.outcome,
          ...(event.error === undefined ? {} : { error: event.error }),
        }),
    });
  }

  async invoke(
    call: AuthorizedToolCall,
    middleware: readonly ToolExecutionMiddleware[],
    correlation: { toolCallId?: string; batchId?: string } = {},
    observation: RuntimeExecutionObservation = NOOP_RUNTIME_EXECUTION_OBSERVATION,
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
      const rawResult = await observation.run(() => this.executeAuthorized(call));
      const result = redactExactSensitiveValue(
        rawResult,
        call.executionPlan.sensitiveValues,
      ) as ToolResult;
      throwIfAborted(call.context.signal);
      for (const entry of middleware) await entry.afterExecute?.(executionContext, result);
      throwIfAborted(call.context.signal);
      const executionMs = Date.now() - executionStartedAt;
      observation.complete({
        toolName: call.tool.name,
        ...correlation,
        result,
        executionMs,
      });
      return { result, executionMs };
    } catch (error) {
      if (isAbortError(error, call.context.signal)) {
        observation.cancel({ error });
        throw error;
      }
      const result = redactExactSensitiveValue(
        error instanceof ToolTimeoutError ? timeoutResult(error) : toolError(error),
        call.executionPlan.sensitiveValues,
      ) as ToolResult;
      const executionMs = Date.now() - executionStartedAt;
      const fact = {
        toolName: call.tool.name,
        ...correlation,
        result,
        executionMs,
      };
      if (error instanceof ToolTimeoutError) observation.timeout({ ...fact, error });
      else observation.complete(fact);
      return { result, executionMs };
    }
  }

  private async executeAuthorized(call: AuthorizedToolCall): Promise<ToolResult> {
    const timeoutMs = resolveToolTimeout(call.tool.timeout, call.input);
    return this.deadlineSupervisor.run({
      operationName: call.tool.name,
      timeoutMs,
      externalSignal: call.context.signal,
      createTimeoutError: (duration) => new ToolTimeoutError(duration),
      execute: (signal) => this.startExecution(call, signal),
    });
  }

  private startExecution(call: AuthorizedToolCall, signal: AbortSignal): Promise<ToolResult> {
    const context = { cwd: call.context.cwd, signal, network: call.context.network };
    const tool = call.tool;
    if (isInProcessTool(tool)) {
      return tool.execute(call.input, context);
    }
    const process = call.executionPlan.process;
    if (!process) throw new Error("Authorized Process Tool is missing its execution plan");
    return this.options.processRouter
      .run(process, signal)
      .then((result) => tool.createToolResult(result, call.input, context));
  }
}

function timeoutResult(error: ToolTimeoutError): ToolResult {
  return {
    content: [{ type: "text", text: error.message }],
    isError: true,
    meta: { code: error.code, timeoutMs: error.timeoutMs, retryable: true },
  };
}

function toolError(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : undefined;
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    ...(code ? { meta: { code, retryable: false } } : {}),
  };
}
