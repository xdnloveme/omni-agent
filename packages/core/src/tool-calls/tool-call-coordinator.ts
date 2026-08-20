import { isAbortError, throwIfAborted } from "../execution";
import { assertJsonObject } from "../data";
import type { ToolInvocationRunner } from "../execution";
import { sanitizeSensitiveValue } from "../security";
import { collectLifecycleEndEvents, collectLifecycleStartEvents } from "../tool-lifecycle";
import type { RegisteredAgentTool, ToolResult } from "../types";
import {
  NOOP_RUNTIME_TOOL_BATCH_OBSERVATION,
  type RuntimeToolBatchObservation,
  type RuntimeToolCallObservation,
} from "../runtime-observation";
import type { ToolInputValidator } from "./tool-input-validator";
import type { ToolAuthorizationResult, ToolAuthorizer } from "./tool-authorization-router";
import type {
  ToolCallEnvironment,
  ToolCallEvent,
  ToolCallMetrics,
  ToolCallRequest,
  ValidatedToolResult,
} from "./types";

export interface ToolCallCoordinatorOptions {
  authorizer: ToolAuthorizer;
  invocationRunner: ToolInvocationRunner;
  inputValidator: ToolInputValidator;
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
      ...(tool?.authorization.hiddenInputKeys
        ? { hiddenInputKeys: tool.authorization.hiddenInputKeys }
        : {}),
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

      try {
        const validationError = this.options.inputValidator.validate(tool.schema, request.input);
        yield startEvent(request, tool.authorization.hiddenInputKeys);
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

        let authorization: ToolAuthorizationResult;
        const authorizationObservation = callObservation.startAuthorization({
          toolName: request.toolName,
          toolCallId: request.toolCallId,
        });
        try {
          authorization = await authorizationObservation.run(() =>
            this.options.authorizer.authorize({
              tool,
              input: request.input,
              context: {
                cwd: environment.cwd,
                agentId: environment.agentId,
                toolIdentity: tool.toolIdentity,
                toolCallId: request.toolCallId,
                signal: request.signal,
              },
            }),
          );
          if (authorization.outcome === "denied") {
            authorizationObservation.deny({
              authorizationMs: authorization.authorizationMs,
            });
          } else {
            authorizationObservation.complete({
              outcome: "allowed",
              authorizationMs: authorization.authorizationMs,
            });
          }
        } catch (error) {
          if (isAbortError(error, request.signal)) {
            authorizationObservation.cancel({ error });
            throw error;
          }
          authorizationObservation.fail({ error });
          const result = errorResult("Tool authorization failed.", {
            code: "tool_authorization_failed",
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
        if (authorization.outcome === "denied") {
          yield finishToolCall(
            callObservation,
            request,
            environment,
            authorization.result,
            metrics(totalStartedAt, authorization.authorizationMs),
            "deny",
          );
          return;
        }

        const createLifecycleInput = () =>
          structuredClone(authorization.call.input) as Record<string, unknown>;
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
            authorization.call,
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
        const callMetrics = metrics(
          totalStartedAt,
          authorization.authorizationMs,
          invocation.executionMs,
        );
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
        const result = errorResult(error instanceof Error ? error.message : String(error));
        yield finishToolCall(
          callObservation,
          request,
          environment,
          result,
          metrics(totalStartedAt),
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

function startEvent(request: ToolCallRequest, hiddenInputKeys?: readonly string[]): ToolCallEvent {
  return {
    type: "tool_start",
    toolName: request.toolName,
    toolCallId: request.toolCallId,
    input: sanitizeSensitiveValue(request.input, hiddenInputKeys) as Record<string, unknown>,
  };
}

function metrics(totalStartedAt: number, authorizationMs = 0, executionMs = 0): ToolCallMetrics {
  return { authorizationMs, executionMs, totalMs: Date.now() - totalStartedAt };
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
