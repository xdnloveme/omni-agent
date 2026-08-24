import {
  createAuthorizedToolCall,
  isAbortError,
  throwIfAborted,
  type ProcessExecutionPlannerPort,
  type HostRuntimeContext,
  type ToolExecutionPlan,
} from "../execution";
import { assertJsonObject } from "../data";
import type { ToolInvocationRunner } from "../execution";
import type { ToolAccessController, ToolAccessResult } from "../access";
import { sanitizeSensitiveValue } from "../security";
import { collectLifecycleEndEvents, collectLifecycleStartEvents } from "../tool-lifecycle";
import { isProcessTool, type RegisteredAgentTool, type ToolResult } from "../types";
import {
  NOOP_RUNTIME_TOOL_BATCH_OBSERVATION,
  type RuntimeToolBatchObservation,
  type RuntimeToolCallObservation,
} from "../runtime-observation";
import type { ToolInputValidator } from "./tool-input-validator";
import type {
  ToolCallEnvironment,
  ToolCallEvent,
  ToolCallMetrics,
  ToolCallRequest,
  ValidatedToolResult,
} from "./types";

export interface ToolCallCoordinatorOptions {
  accessController: ToolAccessController;
  invocationRunner: ToolInvocationRunner;
  processPlanner: ProcessExecutionPlannerPort;
  inputValidator: ToolInputValidator;
  hostRuntime: HostRuntimeContext;
}

export class ToolCallCoordinator {
  constructor(private readonly options: ToolCallCoordinatorOptions) {}

  async *run(
    tools: readonly RegisteredAgentTool[],
    request: ToolCallRequest,
    environment: ToolCallEnvironment,
    batchObservation: RuntimeToolBatchObservation = NOOP_RUNTIME_TOOL_BATCH_OBSERVATION,
  ): AsyncGenerator<ToolCallEvent> {
    const totalStartedAt = Date.now();
    const tool = tools.find((candidate) => candidate.name === request.toolName);
    throwIfAborted(request.signal);
    const callObservation = batchObservation.startCall({
      toolName: request.toolName,
      toolCallId: request.toolCallId,
      ...(environment.batchId ? { batchId: environment.batchId } : {}),
      input: request.input,
      ...(tool?.access.hiddenInputKeys ? { hiddenInputKeys: tool.access.hiddenInputKeys } : {}),
    });
    try {
      if (!tool) {
        yield startEvent(request);
        const result = errorResult(`Tool not found: ${request.toolName}`);
        const callMetrics = metrics(totalStartedAt);
        yield finishToolCall(
          callObservation,
          request,
          environment,
          result,
          callMetrics,
          "complete",
        );
        return;
      }

      let completedAccessMs = 0;
      try {
        const validationError = this.options.inputValidator.validate(tool.schema, request.input);
        yield startEvent(request, tool.access.hiddenInputKeys);
        if (validationError) {
          const result = errorResult(`Invalid tool input: ${validationError}`, {
            code: "invalid_tool_input",
          });
          yield finishToolCall(
            callObservation,
            request,
            environment,
            result,
            metrics(totalStartedAt),
            "complete",
          );
          return;
        }

        if (tool.preflight) {
          const preflightObservation = callObservation.startPreflight({
            toolName: request.toolName,
            toolCallId: request.toolCallId,
          });
          let preflight;
          try {
            preflight = await preflightObservation.run(() =>
              tool.preflight!.validate(request.input, {
                cwd: environment.cwd,
                hostRuntime: this.options.hostRuntime,
                signal: request.signal,
              }),
            );
            preflightObservation.complete({ outcome: preflight.outcome });
          } catch (error) {
            if (isAbortError(error, request.signal)) {
              preflightObservation.cancel({ error });
              throw error;
            }
            preflightObservation.fail({ error });
            const result = errorResult("Tool preflight failed.", {
              code: "tool_preflight_failed",
            });
            yield finishToolCall(
              callObservation,
              request,
              environment,
              result,
              metrics(totalStartedAt),
              "complete",
            );
            return;
          }
          throwIfAborted(request.signal);
          if (preflight.outcome === "error") {
            yield finishToolCall(
              callObservation,
              request,
              environment,
              preflight.result,
              metrics(totalStartedAt),
              "complete",
            );
            return;
          }
        }

        let access: ToolAccessResult;
        const accessObservation = callObservation.startAccess({
          toolName: request.toolName,
          toolCallId: request.toolCallId,
        });
        try {
          access = await accessObservation.run(() =>
            this.options.accessController.authorize({
              tool,
              input: request.input,
              context: {
                cwd: environment.cwd,
                workspaceId: environment.workspaceId,
                workspaceRoot: environment.workspaceRoot,
                agentId: environment.agentId,
                toolCallId: request.toolCallId,
                hostRuntime: this.options.hostRuntime,
                signal: request.signal,
              },
            }),
          );
          if (access.outcome === "denied") {
            accessObservation.deny({
              accessMs: access.accessMs,
            });
          } else {
            completedAccessMs = access.accessMs;
            accessObservation.complete({
              outcome: "allowed",
              accessMs: access.accessMs,
            });
          }
        } catch (error) {
          if (isAbortError(error, request.signal)) {
            accessObservation.cancel({ error });
            throw error;
          }
          accessObservation.fail({ error });
          const result = errorResult("Tool access evaluation failed.", {
            code: "tool_access_failed",
          });
          yield finishToolCall(
            callObservation,
            request,
            environment,
            result,
            metrics(totalStartedAt),
            "complete",
          );
          return;
        }
        throwIfAborted(request.signal);
        if (access.outcome === "denied") {
          yield finishToolCall(
            callObservation,
            request,
            environment,
            access.result,
            metrics(totalStartedAt, access.accessMs),
            "deny",
          );
          return;
        }

        const executionContext = { cwd: environment.cwd, signal: request.signal };
        const executionPlan: ToolExecutionPlan = isProcessTool(tool)
          ? {
              mode: access.grant.mode,
              process: await this.options.processPlanner.prepare({
                tool,
                input: access.grant.input,
                context: executionContext,
                access: access.grant.processAccess,
                executableRequirements: access.grant.executableRequirements,
              }),
            }
          : { mode: access.grant.mode };
        throwIfAborted(request.signal);
        const call = createAuthorizedToolCall(
          tool,
          access.grant.input,
          executionContext,
          executionPlan,
        );
        const createLifecycleInput = () => structuredClone(call.input) as Record<string, unknown>;
        for (const event of collectLifecycleStartEvents(
          environment.lifecycleAdapters,
          {
            toolName: tool.name,
            toolCallId: request.toolCallId,
          },
          createLifecycleInput,
        )) {
          yield event;
        }

        const executionFact = {
          toolName: request.toolName,
          toolCallId: request.toolCallId,
          ...(environment.batchId ? { batchId: environment.batchId } : {}),
        };
        const executionObservation = callObservation.startExecution(executionFact);
        const invocation = await callObservation.run(() =>
          this.options.invocationRunner.invoke(
            call,
            environment.middleware,
            {
              toolCallId: request.toolCallId,
              ...(environment.batchId ? { batchId: environment.batchId } : {}),
            },
            executionObservation,
          ),
        );
        throwIfAborted(request.signal);
        for (const event of collectLifecycleEndEvents(
          environment.lifecycleAdapters,
          {
            toolName: tool.name,
            toolCallId: request.toolCallId,
            result: invocation.result,
            durationMs: invocation.executionMs,
          },
          createLifecycleInput,
        )) {
          yield event;
        }
        const callMetrics = metrics(totalStartedAt, access.accessMs, invocation.executionMs);
        yield finishToolCall(
          callObservation,
          request,
          environment,
          invocation.result,
          callMetrics,
          "complete",
        );
      } catch (error) {
        if (isAbortError(error, request.signal)) {
          throw error;
        }
        const result = errorResult(
          error instanceof Error ? error.message : String(error),
          stableErrorMeta(error),
        );
        yield finishToolCall(
          callObservation,
          request,
          environment,
          result,
          metrics(totalStartedAt, completedAccessMs),
          "complete",
        );
      }
    } catch (error) {
      if (isAbortError(error, request.signal)) callObservation.cancel({ error });
      else callObservation.fail({ error });
      throw error;
    }
  }
}

function stableErrorMeta(error: unknown): Record<string, unknown> | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? { code: error.code, retryable: false } : undefined;
}

function startEvent(request: ToolCallRequest, hiddenInputKeys?: readonly string[]): ToolCallEvent {
  return {
    type: "tool_start",
    toolName: request.toolName,
    toolCallId: request.toolCallId,
    input: sanitizeSensitiveValue(request.input, hiddenInputKeys) as Record<string, unknown>,
  };
}

function metrics(totalStartedAt: number, accessMs = 0, executionMs = 0): ToolCallMetrics {
  return { accessMs, executionMs, totalMs: Date.now() - totalStartedAt };
}

function endEvent(
  request: ToolCallRequest,
  result: ToolResult,
  callMetrics: ToolCallMetrics,
): Extract<ToolCallEvent, { type: "tool_end" }> {
  return {
    type: "tool_end",
    toolName: request.toolName,
    toolCallId: request.toolCallId,
    result: validateToolResult(result, request.toolName),
    durationMs: callMetrics.executionMs,
    metrics: callMetrics,
  };
}

function finishToolCall(
  observation: RuntimeToolCallObservation,
  request: ToolCallRequest,
  environment: ToolCallEnvironment,
  result: ToolResult,
  callMetrics: ToolCallMetrics,
  terminal: "complete" | "deny",
): Extract<ToolCallEvent, { type: "tool_end" }> {
  const event = endEvent(request, result, callMetrics);
  observation.result({
    toolName: request.toolName,
    toolCallId: request.toolCallId,
    ...(environment.batchId ? { batchId: environment.batchId } : {}),
    result: event.result,
    metrics: callMetrics,
  });
  if (terminal === "deny") observation.deny({ result });
  else observation.complete({ result });
  return event;
}

function validateToolResult(result: ToolResult, toolName: string): ValidatedToolResult {
  if (result.meta === undefined) return { content: result.content, isError: result.isError };
  assertJsonObject(result.meta, `Tool result metadata: ${toolName}`);
  const { presentation: _presentation, ...transcriptDetails } = result.meta;
  return {
    ...result,
    meta: result.meta,
    ...(Object.keys(transcriptDetails).length > 0 ? { transcriptDetails } : {}),
  };
}

function errorResult(message: string, meta?: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    ...(meta ? { meta } : {}),
  };
}
