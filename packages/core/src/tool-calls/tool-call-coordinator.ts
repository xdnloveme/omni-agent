import {
  createAuthorizedToolCall,
  isAbortError,
  throwIfAborted,
  type HostRuntimeContext,
  type ProcessExecutionPlannerPort,
  type ToolExecutionPlan,
} from "../execution";
import { assertJsonObject, isJsonValue } from "../data";
import type { ToolInvocationRunner } from "../execution";
import type { PreparedToolAccess, ToolAccessController, ToolAccessResult } from "../access";
import type { NetworkRuntimeLease, NetworkRuntimePort } from "../network";
import { sanitizeSensitiveValue } from "../security";
import { collectLifecycleEndEvents, collectLifecycleStartEvents } from "../tool-lifecycle";
import { isProcessTool, type ToolResult } from "../types";
import {
  NOOP_RUNTIME_TOOL_BATCH_OBSERVATION,
  type RuntimeToolBatchObservation,
  type RuntimeToolCallObservation,
} from "../runtime-observation";
import type { ToolInputValidator } from "./tool-input-validator";
import type {
  PreparedToolBatch,
  PreparedToolCall,
  PreparedToolExecutionContext,
  ToolBatchPreparationRequest,
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
  networkRuntime?: NetworkRuntimePort;
}

interface PreparedState {
  readonly request: ToolCallRequest;
  readonly environment: ToolCallEnvironment;
  readonly observation: RuntimeToolCallObservation;
  readonly totalStartedAt: number;
  readonly access?: PreparedToolAccess;
}

export class ToolCallCoordinator {
  private readonly prepared = new WeakMap<PreparedToolCall, PreparedState>();

  constructor(private readonly options: ToolCallCoordinatorOptions) {}

  async prepareBatch(request: ToolBatchPreparationRequest): Promise<PreparedToolBatch> {
    const batchObservation = request.observation ?? NOOP_RUNTIME_TOOL_BATCH_OBSERVATION;
    const calls: PreparedToolCall[] = [];
    for (const call of request.calls) {
      throwIfAborted(call.signal);
      const totalStartedAt = Date.now();
      const tool = request.tools.find((candidate) => candidate.name === call.toolName);
      const observation = batchObservation.startCall({
        toolName: call.toolName,
        toolCallId: call.toolCallId,
        ...(request.environment.batchId ? { batchId: request.environment.batchId } : {}),
        input: call.input,
        ...(tool?.access.hiddenInputKeys ? { hiddenInputKeys: tool.access.hiddenInputKeys } : {}),
      });
      let preparedCall: PreparedToolCall;
      let access: PreparedToolAccess | undefined;
      if (!tool) {
        preparedCall = failedPrepared(call, errorResult(`Tool not found: ${call.toolName}`));
      } else {
        const validationError = this.options.inputValidator.validate(tool.schema, call.input);
        if (validationError) {
          preparedCall = failedPrepared(
            call,
            errorResult(`Invalid tool input: ${validationError.message}`, {
              code: "invalid_tool_input",
              issues: validationError.issues,
              truncated: validationError.truncated,
            }),
            tool,
          );
        } else {
          const preflightFailure = await this.runPreflight(
            tool,
            call,
            request.environment,
            observation,
          );
          if (preflightFailure) {
            preparedCall = failedPrepared(call, preflightFailure, tool);
          } else {
            try {
              access = await this.options.accessController.prepare({
                tool,
                input: call.input,
                context: accessContext(call, request.environment, this.options.hostRuntime),
              });
              preparedCall = Object.freeze({
                toolName: call.toolName,
                toolCallId: call.toolCallId,
                input: access.input,
                tool,
                accessIntent: access.intent,
                preparation: "ready",
              }) as PreparedToolCall;
            } catch (error) {
              if (isAbortError(error, call.signal)) throw error;
              preparedCall = failedPrepared(
                call,
                errorResult(error instanceof Error ? error.message : String(error), {
                  code: "tool_access_preparation_failed",
                  retryable: false,
                }),
                tool,
              );
            }
          }
        }
      }
      this.prepared.set(preparedCall, {
        request: call,
        environment: request.environment,
        observation,
        totalStartedAt,
        ...(access ? { access } : {}),
      });
      calls.push(preparedCall);
    }
    return Object.freeze({ calls: Object.freeze(calls) });
  }

  async *authorizeAndRun(
    call: PreparedToolCall,
    context: PreparedToolExecutionContext,
  ): AsyncGenerator<ToolCallEvent> {
    const state = this.prepared.get(call);
    if (!state || state.environment !== context.environment) {
      throw new Error("Prepared Tool call is invalid or belongs to another execution context");
    }
    this.prepared.delete(call);
    const { request, environment, observation, totalStartedAt } = state;
    yield startEvent(request, call.tool?.access.hiddenInputKeys, call.input);
    if (call.preparation === "failed") {
      yield finishToolCall(
        observation,
        request,
        environment,
        call.failure ?? errorResult("Tool preparation failed", { code: "tool_preparation_failed" }),
        metrics(totalStartedAt),
        "complete",
      );
      return;
    }

    let completedAccessMs = 0;
    let networkLease: NetworkRuntimeLease | undefined;
    try {
      const access = await this.authorize(call, state);
      if (access.outcome === "denied") {
        yield finishToolCall(
          observation,
          request,
          environment,
          access.result,
          metrics(totalStartedAt, access.accessMs),
          "deny",
        );
        return;
      }
      completedAccessMs = access.accessMs;
      const stopped = await context.revalidate?.();
      if (stopped) {
        yield finishToolCall(
          observation,
          request,
          environment,
          stopped,
          metrics(totalStartedAt, completedAccessMs),
          "complete",
        );
        return;
      }
      const processTool = isProcessTool(call.tool!);
      if (access.grant.network) {
        if (!this.options.networkRuntime)
          throw codedError(
            "network_runtime_unavailable",
            "Authorized network access is unavailable on this host.",
          );
        networkLease = await this.options.networkRuntime.open(access.grant.network, {
          mode: access.grant.mode,
          agentId: environment.agentId,
          workspaceId: environment.workspaceId,
          toolCallId: request.toolCallId,
          execution: processTool ? "process" : "in_process",
          signal: request.signal,
        });
      }
      const executionContext = {
        outputs: environment.outputs,
        cwd: environment.cwd,
        signal: request.signal,
        ...(networkLease ? { network: networkLease.client } : {}),
      };
      const sensitiveValues = networkLease
        ? { exactValues: networkLease.sensitiveValues }
        : undefined;
      const executionPlan: ToolExecutionPlan = processTool
        ? {
            mode: access.grant.mode,
            ...(access.grant.network ? { network: access.grant.network } : {}),
            ...(sensitiveValues ? { sensitiveValues } : {}),
            process: await this.options.processPlanner.prepare({
              tool: call.tool!,
              input: access.grant.input,
              context: executionContext,
              access: access.grant.processAccess,
              executableRequirements: access.grant.executableRequirements,
              networkProxy: networkLease?.processProxy,
              sensitiveValues,
            }),
          }
        : {
            mode: access.grant.mode,
            ...(access.grant.network ? { network: access.grant.network } : {}),
            ...(sensitiveValues ? { sensitiveValues } : {}),
          };
      throwIfAborted(request.signal);
      const authorizedCall = createAuthorizedToolCall(
        call.tool!,
        access.grant.input,
        executionContext,
        executionPlan,
      );
      const createLifecycleInput = () =>
        structuredClone(authorizedCall.input) as Record<string, unknown>;
      for (const event of collectLifecycleStartEvents(
        environment.lifecycleAdapters,
        { toolName: call.toolName, toolCallId: call.toolCallId },
        createLifecycleInput,
      ))
        yield event;
      const executionObservation = observation.startExecution({
        toolName: call.toolName,
        toolCallId: call.toolCallId,
        ...(environment.batchId ? { batchId: environment.batchId } : {}),
      });
      const invocation = await observation.run(() =>
        this.options.invocationRunner.invoke(
          authorizedCall,
          environment.middleware,
          {
            toolCallId: call.toolCallId,
            ...(environment.batchId ? { batchId: environment.batchId } : {}),
          },
          executionObservation,
        ),
      );
      throwIfAborted(request.signal);
      for (const event of collectLifecycleEndEvents(
        environment.lifecycleAdapters,
        {
          toolName: call.toolName,
          toolCallId: call.toolCallId,
          result: invocation.result,
          durationMs: invocation.executionMs,
        },
        createLifecycleInput,
      ))
        yield event;
      yield finishToolCall(
        observation,
        request,
        environment,
        invocation.result,
        metrics(totalStartedAt, access.accessMs, invocation.executionMs, true),
        "complete",
      );
    } catch (error) {
      if (isAbortError(error, request.signal)) {
        observation.cancel({ error });
        throw error;
      }
      yield finishToolCall(
        observation,
        request,
        environment,
        errorResult(error instanceof Error ? error.message : String(error), stableErrorMeta(error)),
        metrics(totalStartedAt, completedAccessMs),
        "complete",
      );
    } finally {
      await networkLease?.close();
    }
  }

  async *defer(
    call: PreparedToolCall,
    context: PreparedToolExecutionContext,
    result: ToolResult,
  ): AsyncGenerator<ToolCallEvent> {
    const state = this.prepared.get(call);
    if (!state || state.environment !== context.environment) {
      throw new Error("Prepared Tool call is invalid or belongs to another execution context");
    }
    this.prepared.delete(call);
    yield startEvent(state.request, call.tool?.access.hiddenInputKeys, call.input);
    yield finishToolCall(
      state.observation,
      state.request,
      state.environment,
      result,
      metrics(state.totalStartedAt),
      "complete",
    );
  }

  private async authorize(call: PreparedToolCall, state: PreparedState): Promise<ToolAccessResult> {
    if (!state.access) throw new Error("Prepared Tool call is missing access facts");
    const accessObservation = state.observation.startAccess({
      toolName: call.toolName,
      toolCallId: call.toolCallId,
    });
    try {
      const access = await accessObservation.run(() =>
        this.options.accessController.authorizePrepared(state.access!),
      );
      if (access.outcome === "denied") accessObservation.deny({ accessMs: access.accessMs });
      else accessObservation.complete({ outcome: "allowed", accessMs: access.accessMs });
      return access;
    } catch (error) {
      if (isAbortError(error, state.request.signal)) accessObservation.cancel({ error });
      else accessObservation.fail({ error });
      throw error;
    }
  }

  private async runPreflight(
    tool: NonNullable<PreparedToolCall["tool"]>,
    request: ToolCallRequest,
    environment: ToolCallEnvironment,
    observation: RuntimeToolCallObservation,
  ): Promise<ToolResult | undefined> {
    if (!tool.preflight) return undefined;
    const preflightObservation = observation.startPreflight({
      toolName: request.toolName,
      toolCallId: request.toolCallId,
    });
    try {
      const result = await preflightObservation.run(() =>
        tool.preflight!.validate(request.input, {
          cwd: environment.cwd,
          hostRuntime: this.options.hostRuntime,
          signal: request.signal,
        }),
      );
      preflightObservation.complete({ outcome: result.outcome });
      return result.outcome === "error" ? result.result : undefined;
    } catch (error) {
      if (isAbortError(error, request.signal)) {
        preflightObservation.cancel({ error });
        throw error;
      }
      preflightObservation.fail({ error });
      return errorResult("Tool preflight failed.", { code: "tool_preflight_failed" });
    }
  }
}

function accessContext(
  request: ToolCallRequest,
  environment: ToolCallEnvironment,
  hostRuntime: HostRuntimeContext,
) {
  return {
    cwd: environment.cwd,
    workspaceId: environment.workspaceId,
    workspaceRoot: environment.workspaceRoot,
    agentId: environment.agentId,
    toolCallId: request.toolCallId,
    hostRuntime,
    signal: request.signal,
    ...(environment.onPermissionResolved
      ? { onPermissionResolved: environment.onPermissionResolved }
      : {}),
  };
}

function failedPrepared(
  request: ToolCallRequest,
  result: ToolResult,
  tool?: NonNullable<PreparedToolCall["tool"]>,
): PreparedToolCall {
  return Object.freeze({
    toolName: request.toolName,
    toolCallId: request.toolCallId,
    input: Object.freeze(structuredClone(request.input)),
    ...(tool ? { tool } : {}),
    preparation: "failed",
    failure: validateToolResult(result, request.toolName),
  }) as PreparedToolCall;
}

function codedError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function stableErrorMeta(error: unknown): Record<string, unknown> | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? { code: error.code, retryable: false } : undefined;
}

function startEvent(
  request: ToolCallRequest,
  hiddenInputKeys?: readonly string[],
  input: Readonly<Record<string, unknown>> = request.input,
): ToolCallEvent {
  return {
    type: "tool_start",
    toolName: request.toolName,
    toolCallId: request.toolCallId,
    input: sanitizeSensitiveValue(input, hiddenInputKeys) as Record<string, unknown>,
  };
}

function metrics(
  totalStartedAt: number,
  accessMs = 0,
  executionMs = 0,
  executed = false,
): ToolCallMetrics {
  return { executed, accessMs, executionMs, totalMs: Date.now() - totalStartedAt };
}

function finishToolCall(
  observation: RuntimeToolCallObservation,
  request: ToolCallRequest,
  environment: ToolCallEnvironment,
  result: ToolResult,
  callMetrics: ToolCallMetrics,
  terminal: "complete" | "deny",
): Extract<ToolCallEvent, { type: "tool_end" }> {
  const event = {
    type: "tool_end" as const,
    toolName: request.toolName,
    toolCallId: request.toolCallId,
    result: validateToolResult(result, request.toolName),
    durationMs: callMetrics.executionMs,
    metrics: callMetrics,
  };
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
  if (result.structuredContent !== undefined && !isJsonValue(result.structuredContent)) {
    throw new Error(`Tool structured result must be JSON: ${toolName}`);
  }
  if (result.meta === undefined) {
    return {
      content: result.content,
      isError: result.isError,
      ...(result.structuredContent === undefined
        ? {}
        : { structuredContent: result.structuredContent }),
    };
  }
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
