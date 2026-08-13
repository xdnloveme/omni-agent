import { isAbortError, throwIfAborted } from "../execution";
import { assertJsonObject } from "../data";
import type { ToolInvocationRunner } from "../execution";
import { sanitizeSensitiveValue } from "../permissions";
import { collectLifecycleEndEvents, collectLifecycleStartEvents } from "../tool-lifecycle";
import type { RegisteredAgentTool, ToolResult } from "../types";
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
  ): AsyncGenerator<ToolCallEvent> {
    const totalStartedAt = Date.now();
    throwIfAborted(request.signal);
    const tool = tools.find((candidate) => candidate.name === request.toolName);
    if (!tool) {
      yield startEvent(request);
      yield endEvent(
        request,
        errorResult(`Tool not found: ${request.toolName}`),
        metrics(totalStartedAt),
      );
      return;
    }

    try {
      const validationError = this.options.inputValidator.validate(tool.schema, request.input);
      yield startEvent(request, tool.authorization.hiddenInputKeys);
      if (validationError) {
        yield endEvent(
          request,
          errorResult(`Invalid tool input: ${validationError}`, { code: "invalid_tool_input" }),
          metrics(totalStartedAt),
        );
        return;
      }

      if (tool.preflight) {
        let preflight;
        try {
          preflight = await tool.preflight.validate(request.input, {
            cwd: environment.cwd,
            signal: request.signal,
          });
        } catch (error) {
          if (isAbortError(error, request.signal)) throw error;
          yield endEvent(
            request,
            errorResult("Tool preflight failed.", { code: "tool_preflight_failed" }),
            metrics(totalStartedAt),
          );
          return;
        }
        throwIfAborted(request.signal);
        if (preflight.outcome === "error") {
          yield endEvent(request, preflight.result, metrics(totalStartedAt));
          return;
        }
      }

      let authorization: ToolAuthorizationResult;
      try {
        authorization = await this.options.authorizer.authorize({
          tool,
          input: request.input,
          context: {
            cwd: environment.cwd,
            agentId: environment.agentId,
            toolIdentity: tool.toolIdentity,
            toolCallId: request.toolCallId,
            signal: request.signal,
          },
        });
      } catch (error) {
        if (isAbortError(error, request.signal)) throw error;
        yield endEvent(
          request,
          errorResult("Tool authorization failed.", {
            code: "tool_authorization_failed",
          }),
          metrics(totalStartedAt),
        );
        return;
      }
      throwIfAborted(request.signal);
      if (authorization.outcome === "denied") {
        yield endEvent(
          request,
          authorization.result,
          metrics(totalStartedAt, authorization.authorizationMs),
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

      const invocation = await this.options.invocationRunner.invoke(
        authorization.call,
        environment.middleware,
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
      yield endEvent(
        request,
        invocation.result,
        metrics(totalStartedAt, authorization.authorizationMs, invocation.executionMs),
      );
    } catch (error) {
      if (isAbortError(error, request.signal)) throw error;
      yield endEvent(
        request,
        errorResult(error instanceof Error ? error.message : String(error)),
        metrics(totalStartedAt),
      );
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
): ToolCallEvent {
  return {
    type: "tool_end",
    toolName: request.toolName,
    toolCallId: request.toolCallId,
    result: validateToolResult(result, request.toolName),
    durationMs: callMetrics.executionMs,
    metrics: callMetrics,
  };
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
