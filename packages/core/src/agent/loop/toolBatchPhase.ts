import { cloneData } from "../../dataCopy";
import { isAbortError, throwIfAborted } from "../../execution";
import type { EnvironmentContextRecord } from "../../environment";
import type { LoopProtection } from "../../loop-protection";
import type {
  AssistantTranscriptMessage,
  ToolCallContent,
  TranscriptMessage,
} from "../../messages";
import { iterateObserved, type RuntimeTurnObservation } from "../../runtime-observation";
import type { StreamSession } from "../../stream";
import type { ToolCallCoordinator, ToolCallMetrics, ValidatedToolResult } from "../../tool-calls";
import { evaluateToolBatchPolicies } from "../../tool-calls/preparation-policies";
import type { AgentConfig, AgentEvent } from "../../types";
import { dispatchPostEventHooks } from "../../hooks";
import { createToolBatchDescriptor, firstTurnBarrierIndex } from "../toolBatch";
import type { PublishAgentEvent, ToolBatchPhaseResult } from "./types";

export interface ToolBatchPhaseInput {
  readonly agentId: string;
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly config: AgentConfig;
  readonly response: AssistantTranscriptMessage;
  readonly modelCallId: string;
  readonly environment: EnvironmentContextRecord;
  readonly coordinator: ToolCallCoordinator;
  readonly loopProtection: LoopProtection;
  readonly observation: RuntimeTurnObservation;
  readonly publish: PublishAgentEvent;
  readonly session?: StreamSession;
  readonly signal?: AbortSignal;
}

export async function* executeToolBatchPhase(
  input: ToolBatchPhaseInput,
): AsyncGenerator<AgentEvent, ToolBatchPhaseResult> {
  const toolCalls = input.response.content.filter(
    (block): block is ToolCallContent => block.type === "toolCall",
  );
  input.loopProtection.beginToolBatch(toolCalls);
  const toolResultMessages: TranscriptMessage[] = [];
  const batchStartedAt = Date.now();
  const batch = createToolBatchDescriptor(toolCalls, input.config.tools, input.modelCallId);
  const batchStartedEvent: AgentEvent = {
    type: "tool_batch_started",
    batch: cloneData(batch),
  };
  const observation = input.observation.startToolBatch({ batch });
  try {
    yield input.publish(batchStartedEvent, {
      type: "tool_batch_started",
      batch: cloneData(batch),
    });

    const environment = {
      agentId: input.agentId,
      workspaceId: input.workspaceId,
      workspaceRoot: input.workspaceRoot,
      batchId: batch.batchId,
      cwd: input.environment.snapshot.workspace.cwd,
      middleware: input.config.middleware ?? [],
      lifecycleAdapters: input.config.toolLifecycleAdapters ?? [],
      onPermissionResolved: (event: {
        readonly permissionId: string;
        readonly decision: "approve" | "deny";
        readonly reason: string;
      }) =>
        dispatchPostEventHooks(
          { type: "permission.resolved", ...event },
          {
            config: input.config,
            coordinator: input.coordinator,
            environment: hookEnvironment(input),
            signal: input.signal,
          },
        ),
    };
    const preparedBatch = await input.coordinator.prepareBatch({
      tools: input.config.tools,
      calls: toolCalls.map((call) => ({
        toolName: call.name,
        toolCallId: call.id,
        input: call.arguments,
        signal: input.signal,
      })),
      environment,
      observation,
    });
    const policies = input.config.toolBatchPreparationPolicies ?? [];
    const preparationDecision = await evaluateToolBatchPolicies(policies, preparedBatch, {
      origin: "agent",
    });
    let policyResult = preparationDecision.kind === "executable" ? undefined : preparationDecision;
    if (preparationDecision.kind === "deferred") {
      yield input.publish({
        type: "tool_batch_deferred",
        batchId: batch.batchId,
        code: preparationDecision.code,
        retryable: true,
      });
    }

    const turnBarrierIndex = firstTurnBarrierIndex(toolCalls, input.config.tools);

    for (const [index, call] of toolCalls.entries()) {
      throwIfAborted(input.signal);
      const position = { batchId: batch.batchId, index, total: toolCalls.length };
      const preview = batch.members[index]!.preview;
      const preparedCall = preparedBatch.calls[index]!;
      const policyStopped = preparedCall.preparation === "ready" && policyResult !== undefined;

      let result: ValidatedToolResult | undefined;
      let executed = false;
      let durationMs = 0;
      const turnBarrierStopped =
        preparedCall.preparation === "ready" &&
        turnBarrierIndex !== undefined &&
        index !== turnBarrierIndex;
      const events = policyStopped
        ? input.coordinator.defer(
            preparedCall,
            { environment, observation },
            policyStoppedToolResult(policyResult!),
          )
        : turnBarrierStopped
          ? input.coordinator.defer(
              preparedCall,
              { environment, observation },
              deferredToolResult(
                "tool_batch_deferred",
                "This call was not executed because the batch contained a turn barrier. Reissue it if it is still needed.",
              ),
            )
          : input.coordinator.authorizeAndRun(preparedCall, {
              environment,
              observation,
              revalidate: async () => {
                const decision = await evaluateToolBatchPolicies(policies, preparedBatch, {
                  origin: "agent",
                });
                if (decision.kind === "executable") return undefined;
                policyResult = decision;
                return policyStoppedToolResult(decision);
              },
            });
      {
        for await (const event of iterateObserved(observation, () => events)) {
          if (event.type === "tool_start") {
            yield publishToolStart(
              input.session,
              event.toolName,
              event.toolCallId,
              event.input,
              preview,
              position,
            );
          } else if (event.type === "tool_end") {
            result = event.result;
            executed = event.metrics?.executed === true;
            durationMs = event.durationMs;
            yield publishToolEnd(
              input.session,
              event.toolName,
              event.toolCallId,
              event.result,
              event.durationMs,
              position,
              event.metrics,
            );
          } else {
            input.session?.handle(event);
            yield event;
          }
        }
      }
      throwIfAborted(input.signal);
      if (!result) throw new Error(`Tool call completed without a result: ${call.name}`);
      const preparationDeferred =
        policyResult?.kind === "deferred" && preparedCall.preparation === "ready";
      if (preparationDeferred && !policyStopped) {
        yield input.publish({
          type: "tool_batch_deferred",
          batchId: batch.batchId,
          code: policyResult!.code,
          retryable: true,
        });
      }
      if (!policyStopped && !preparationDeferred) {
        input.loopProtection.observeToolResult({
          call,
          toolIdentity: input.config.tools.find((tool) => tool.name === call.name)?.toolIdentity,
          result,
        });
      }
      if (executed) {
        await dispatchPostEventHooks(
          {
            type: "tool.completed",
            toolName: call.name,
            toolCallId: call.id,
            isError: result.isError,
            durationMs,
          },
          {
            config: input.config,
            coordinator: input.coordinator,
            environment,
            signal: input.signal,
          },
        );
      }

      toolResultMessages.push({
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: result.content,
        ...(result.structuredContent === undefined
          ? {}
          : { structuredContent: cloneData(result.structuredContent) }),
        ...(result.transcriptDetails === undefined
          ? {}
          : { details: cloneData(result.transcriptDetails) }),
        isError: result.isError,
        timestamp: Date.now(),
      });
    }

    const batchCompletedEvent: AgentEvent = {
      type: "tool_batch_completed",
      batchId: batch.batchId,
      modelCallId: input.modelCallId,
      durationMs: Math.max(0, Date.now() - batchStartedAt),
    };
    observation.complete(batchCompletedEvent);
    yield input.publish(batchCompletedEvent);
  } catch (error) {
    if (isAbortError(error, input.signal)) observation.cancel({ error });
    else observation.fail({ error });
    throw error;
  }

  const loopDecision = input.loopProtection.completeToolBatch();
  if (loopDecision.type === "halt") {
    return {
      kind: "halt",
      messages: toolResultMessages,
      failure: {
        code: "tool_loop_detected",
        message: loopDecision.error,
        retryable: false,
      },
      diagnostic: loopDecision.diagnostic,
    };
  }
  return { kind: "continue", messages: toolResultMessages };
}

function hookEnvironment(
  input: ToolBatchPhaseInput,
): import("../../tool-calls").ToolCallEnvironment {
  return {
    agentId: input.agentId,
    workspaceId: input.workspaceId,
    workspaceRoot: input.workspaceRoot,
    cwd: input.environment.snapshot.workspace.cwd,
    middleware: input.config.middleware ?? [],
    lifecycleAdapters: input.config.toolLifecycleAdapters ?? [],
    origin: "hook",
  };
}

function deferredToolResult(code: string, message: string): ValidatedToolResult {
  const details = { code, retryable: true, executed: false } as const;
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: message,
      },
    ],
    meta: details,
    transcriptDetails: details,
  };
}

function policyStoppedToolResult(
  decision: Exclude<
    import("../../tool-calls").ToolBatchPreparationDecision,
    { kind: "executable" }
  >,
): ValidatedToolResult {
  if (decision.kind === "deferred") {
    const update = (decision.promptSections ?? []).map((section) => section.content).join("\n\n");
    return deferredToolResult(
      decision.code,
      [
        decision.message,
        update
          ? "Updated preparation context follows. This call was not executed; reconsider it using this context."
          : "",
        update,
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
  }
  const details = { code: decision.code, retryable: false, executed: false } as const;
  return {
    isError: true,
    content: [{ type: "text", text: decision.message }],
    meta: details,
    transcriptDetails: details,
  };
}

function publishToolStart(
  session: StreamSession | undefined,
  toolName: string,
  toolCallId: string,
  input: Record<string, unknown>,
  preview: import("../../types").ToolInvocationPreview,
  batch: import("../../types").ToolBatchPosition,
): Extract<AgentEvent, { type: "tool_start" }> {
  const event = {
    type: "tool_start" as const,
    toolName,
    toolCallId,
    input: cloneData(input),
    preview: cloneData(preview),
    batch: { ...batch },
  };
  const { type: _type, ...streamEvent } = cloneData(event);
  session?.handle({ type: "tool_use_start", ...streamEvent });
  return event;
}

function publishToolEnd(
  session: StreamSession | undefined,
  toolName: string,
  toolCallId: string,
  result: ValidatedToolResult,
  durationMs: number,
  batch: import("../../types").ToolBatchPosition,
  metrics?: ToolCallMetrics,
): Extract<AgentEvent, { type: "tool_end" }> {
  const event = {
    type: "tool_end" as const,
    toolName,
    toolCallId,
    result: cloneData(result),
    durationMs,
    batch: { ...batch },
    ...(metrics ? { metrics: cloneData(metrics) } : {}),
  };
  const { type: _type, ...streamEvent } = cloneData(event);
  session?.handle({ type: "tool_use_end", ...streamEvent });
  return event;
}
