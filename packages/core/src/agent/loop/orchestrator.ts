import type { ContextEnginePort, ContextMiddlewarePort } from "../../context";
import type { EnvironmentContextControllerPort } from "../../environment";
import type { OutputRecovery } from "./output-recovery";
import { isAbortError, throwIfAborted } from "../../execution";
import type { LoopProtection } from "../../loop-protection";
import type { AssistantTranscriptMessage } from "../../messages";
import type { ModelRuntimePort } from "../../models/runtime";
import type { RuntimeRunObservation } from "../../runtime-observation";
import type { StreamEvent, StreamSession } from "../../stream";
import type { ToolCallCoordinator } from "../../tool-calls";
import type { AgentConfig, AgentEvent, TokenUsage } from "../../types";
import type { WorkingConversation } from "../workingConversation";
import type { LoopIterationResult, PublishAgentEvent } from "./types";
import { maxTurnsFailure, runtimeFailure } from "./failures";
import { streamModelPhase } from "./modelPhase";
import { executeToolBatchPhase } from "./toolBatchPhase";
import { captureEnvironmentPhase, prepareContextPhase } from "./preparation";

export interface LoopIterationInput {
  readonly turn: number;
  readonly maxTurns?: number;
  readonly lastUsage?: TokenUsage;
  readonly agentId: string;
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly config: AgentConfig;
  readonly conversation: WorkingConversation;
  readonly environmentContext: EnvironmentContextControllerPort;
  readonly contextEngine: ContextEnginePort;
  readonly contextMiddleware: readonly ContextMiddlewarePort[];
  readonly modelRuntime: ModelRuntimePort;
  readonly toolCallCoordinator: ToolCallCoordinator;
  readonly loopProtection: LoopProtection;
  readonly outputRecovery: OutputRecovery;
  readonly runObservation: RuntimeRunObservation;
  readonly session?: StreamSession;
  readonly signal?: AbortSignal;
  readonly outputs?: import("../../execution/output").SessionOutputPort;
  readonly deadline?: import("../../execution/run-deadline").RunDeadline;
}

export async function* runLoopIteration(
  input: LoopIterationInput,
): AsyncGenerator<AgentEvent, LoopIterationResult> {
  const turnObservation = input.runObservation.startTurn({ turn: input.turn });
  const publish: PublishAgentEvent = <T extends AgentEvent & StreamEvent>(
    event: T,
    sessionEvent: StreamEvent = event,
  ): T => {
    input.session?.handle(sessionEvent);
    return event;
  };

  try {
    const environment = await captureEnvironmentPhase({
      turn: input.turn,
      conversation: input.conversation,
      environmentContext: input.environmentContext,
      observation: turnObservation,
      signal: input.signal,
      lastUsage: input.lastUsage,
    });
    if (environment.kind === "failed") {
      turnObservation.fail({ turn: input.turn, failure: environment.event.failure });
      yield publish(environment.event, { type: "error", failure: environment.event.failure });
      return { kind: "failed", usage: input.lastUsage };
    }

    const prepared = yield* prepareContextPhase({
      turn: input.turn,
      agentId: input.agentId,
      config: {
        ...input.config,
        systemPrompt: input.config.systemPrompt + input.outputRecovery.instruction,
      },
      conversation: input.conversation,
      contextEngine: input.contextEngine,
      contextMiddleware: input.contextMiddleware,
      loopProtection: input.loopProtection,
      observation: turnObservation,
      publish,
      deadline: input.deadline,
      signal: input.signal,
    });

    const checkpointId = prepared.context.manifest.checkpoint?.checkpointId;
    if (checkpointId) {
      for (const policy of input.config.toolBatchPreparationPolicies ?? [])
        await policy.onContextCheckpoint?.(checkpointId);
    }

    const model = yield* streamModelPhase({
      turn: input.turn,
      agentId: input.agentId,
      sessionId: prepared.sessionId,
      config: input.config,
      preparedContext: prepared.context,
      recovery: input.outputRecovery.context,
      promptLeaseId: prepared.promptLeaseId,
      conversation: input.conversation,
      modelRuntime: input.modelRuntime,
      loopProtection: input.loopProtection,
      observation: turnObservation,
      publish,
      signal: input.signal,
    });
    if (model.kind === "failed") {
      turnObservation.fail({ turn: input.turn, failure: model.event.failure });
      yield publish(model.event, { type: "error", failure: model.event.failure });
      return { kind: "failed", usage: input.lastUsage };
    }

    if (model.response.stopReason === "length") {
      throwIfAborted(input.signal);
      const failure = input.outputRecovery.recover(model.response, model.modelCallId);
      if (failure) {
        turnObservation.fail({ turn: input.turn, failure });
        yield publish(
          { type: "error", failure, produced: input.conversation.produced(), usage: model.usage },
          { type: "error", failure },
        );
        return { kind: "failed", usage: model.usage };
      }
      turnObservation.complete({ turn: input.turn, usage: model.usage });
      return { kind: "continue", usage: model.usage };
    }
    if (model.response.stopReason !== "stop" && model.response.stopReason !== "toolUse") {
      const failure = {
        code: "model_stop_reason_unsupported",
        message: `Model ended with ${model.response.stopReason}.`,
        retryable: false,
      };
      turnObservation.fail({ turn: input.turn, failure });
      yield publish(
        { type: "error", failure, produced: input.conversation.produced(), usage: model.usage },
        { type: "error", failure },
      );
      return { kind: "failed", usage: model.usage };
    }
    input.outputRecovery.reset();
    if (model.response.stopReason === "stop") {
      if (isFinalTextResponse(model.response)) {
        const finalResponseEvent: AgentEvent = {
          type: "final_response",
          modelCallId: model.modelCallId,
        };
        turnObservation.finalResponse({ modelCallId: finalResponseEvent.modelCallId });
        yield publish(finalResponseEvent);
      }
      input.session?.handle({ type: "done", usage: model.usage });
      turnObservation.complete({ turn: input.turn, usage: model.usage });
      yield { type: "done", produced: input.conversation.produced(), usage: model.usage };
      return { kind: "completed", usage: model.usage };
    }

    const tools = yield* executeToolBatchPhase({
      agentId: input.agentId,
      workspaceId: input.workspaceId,
      workspaceRoot: input.workspaceRoot,
      config: input.config,
      response: model.response,
      outputs: input.outputs,
      modelCallId: model.modelCallId,
      environment: prepared.environment,
      coordinator: input.toolCallCoordinator,
      loopProtection: input.loopProtection,
      observation: turnObservation,
      publish,
      session: input.session,
      signal: input.signal,
    });
    for (const message of tools.messages) input.conversation.append(message);
    if (tools.kind === "halt") {
      turnObservation.fail({ turn: input.turn, failure: tools.failure });
      yield publish(
        {
          type: "error",
          failure: tools.failure,
          loop: tools.diagnostic,
          produced: input.conversation.produced(),
          usage: model.usage,
        },
        { type: "error", failure: tools.failure },
      );
      return { kind: "failed", usage: model.usage };
    }

    if (input.maxTurns !== undefined && input.turn + 1 >= input.maxTurns) {
      turnObservation.fail({
        turn: input.turn,
        failure: maxTurnsFailure(input.maxTurns),
      });
      return { kind: "max_turns", maxTurns: input.maxTurns, usage: model.usage };
    }

    turnObservation.complete({ turn: input.turn, usage: model.usage });
    return { kind: "continue", usage: model.usage };
  } catch (error) {
    if (isAbortError(error, input.signal)) turnObservation.cancel({ error });
    else {
      turnObservation.fail({
        turn: input.turn,
        failure: runtimeFailure("agent_turn_failed", error, false),
      });
    }
    throw error;
  }
}

function isFinalTextResponse(message: AssistantTranscriptMessage): boolean {
  return (
    message.stopReason === "stop" &&
    message.content.some((content) => content.type === "text" && content.text.length > 0)
  );
}
