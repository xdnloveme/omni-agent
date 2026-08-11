import type { ToolExecutionMiddleware } from "../middleware";
import type { ToolResult } from "../types";
import { createAbortError, isAbortError, throwIfAborted } from "./abort";
import type {
  AuthorizedExecutionContext,
  AuthorizedToolCall,
  SandboxRunnerPort,
  ToolInvocationResult,
} from "./types";

export interface ToolInvocationRunnerOptions {
  sandboxRunner?: SandboxRunnerPort;
}

export class ToolInvocationRunner {
  constructor(private readonly options: ToolInvocationRunnerOptions = {}) {}

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
      const result = await executeWithTimeout(call, this.options.sandboxRunner);
      throwIfAborted(call.context.signal);
      for (const entry of middleware) await entry.afterExecute?.(executionContext, result);
      throwIfAborted(call.context.signal);
      return { result, executionMs: Date.now() - executionStartedAt };
    } catch (error) {
      if (isAbortError(error, call.context.signal)) throw error;
      return {
        result: toolError(error instanceof Error ? error.message : String(error)),
        executionMs: Date.now() - executionStartedAt,
      };
    }
  }
}

async function executeWithTimeout(
  call: AuthorizedToolCall,
  sandboxRunner?: SandboxRunnerPort,
): Promise<ToolResult> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(call.context.signal?.reason);
  let timeout: NodeJS.Timeout | undefined;
  try {
    const cancellationPromise = new Promise<never>((_, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => {
          const reason = controller.signal.reason;
          reject(reason instanceof Error ? reason : createAbortError());
        },
        { once: true },
      );
    });
    call.context.signal?.addEventListener("abort", onAbort, { once: true });
    if (call.context.signal?.aborted) onAbort();
    const executionRequest = {
      tool: call.tool,
      input: call.input,
      context: { cwd: call.context.cwd, signal: controller.signal },
    };
    const execution =
      call.tool.execution.kind === "sandbox_eligible" && sandboxRunner
        ? sandboxRunner.run({ ...executionRequest, profile: call.tool.execution.profile })
        : call.tool.execute(executionRequest.input, executionRequest.context);
    const competingPromises: Promise<ToolResult>[] = [execution, cancellationPromise];
    if (call.tool.timeoutMs) {
      competingPromises.push(
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            const error = new Error(`Tool timed out after ${call.tool.timeoutMs}ms`);
            controller.abort(error);
            reject(error);
          }, call.tool.timeoutMs);
        }),
      );
    }
    return await Promise.race(competingPromises);
  } finally {
    if (timeout) clearTimeout(timeout);
    call.context.signal?.removeEventListener("abort", onAbort);
  }
}

function toolError(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}
