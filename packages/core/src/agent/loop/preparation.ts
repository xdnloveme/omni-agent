import { randomUUID } from "node:crypto";
import type { PreparedModelContext } from "../../context";
import type { ContextEnginePort, ContextMiddlewarePort } from "../../context";
import { cloneData } from "../../dataCopy";
import { isAbortError } from "../../execution";
import { EnvironmentContextError, type EnvironmentContextControllerPort } from "../../environment";
import type { LoopProtection } from "../../loop-protection";
import type { RuntimeTurnObservation } from "../../runtime-observation";
import type { AgentConfig, AgentEvent, TokenUsage } from "../../types";
import { createContextPreparationRequest } from "../contextInput";
import { createContextPreparationStream } from "../contextPreparationStream";
import type { WorkingConversation } from "../workingConversation";
import { iterateObserved } from "../../runtime-observation";
import type { EnvironmentPhaseResult, PreparedModelInvocation, PublishAgentEvent } from "./types";

export interface EnvironmentPhaseInput {
  readonly turn: number;
  readonly conversation: WorkingConversation;
  readonly environmentContext: EnvironmentContextControllerPort;
  readonly observation: RuntimeTurnObservation;
  readonly signal?: AbortSignal;
  readonly lastUsage?: TokenUsage;
}

export async function captureEnvironmentPhase(
  input: EnvironmentPhaseInput,
): Promise<EnvironmentPhaseResult> {
  const observation = input.observation.startOperation({
    kind: "environment_capture",
    turn: input.turn,
  });
  try {
    const capture = await observation.run(() =>
      input.environmentContext.capture(input.conversation.snapshot().environment, input.signal),
    );
    observation.complete({});
    if (capture.changed) input.conversation.updateEnvironment(capture.context);
    return { kind: "captured" };
  } catch (error) {
    if (isAbortError(error, input.signal)) observation.cancel({ error });
    else observation.fail({ error });
    if (!(error instanceof EnvironmentContextError)) throw error;
    const failure = {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.field ? { field: error.field } : {}),
    };
    return {
      kind: "failed",
      event: {
        type: "error",
        failure,
        produced: input.conversation.produced(),
        usage: input.lastUsage,
      },
    };
  }
}

export interface ContextPhaseInput {
  readonly turn: number;
  readonly agentId: string;
  readonly config: AgentConfig;
  readonly conversation: WorkingConversation;
  readonly contextEngine: ContextEnginePort;
  readonly contextMiddleware: readonly ContextMiddlewarePort[];
  readonly loopProtection: LoopProtection;
  readonly observation: RuntimeTurnObservation;
  readonly publish: PublishAgentEvent;
  readonly signal?: AbortSignal;
}

export async function* prepareContextPhase(
  input: ContextPhaseInput,
): AsyncGenerator<AgentEvent, PreparedModelInvocation> {
  const promptLease = input.loopProtection.leaseSystemPrompt(
    input.config.systemPrompt,
    input.config.tools.length > 0,
  );
  const conversationSnapshot = input.conversation.snapshot();
  const environment = conversationSnapshot.environment;
  if (!environment) throw new Error("Environment context is missing after capture");
  const observation = input.observation.startContext({ turn: input.turn });
  let preparation: ReturnType<typeof createContextPreparationStream>;
  let preparedContext: PreparedModelContext;
  try {
    preparation = observation.run(() =>
      createContextPreparationStream(input.contextEngine, (progress) =>
        createContextPreparationRequest({
          identity: {
            agentId: input.agentId,
            sessionId: conversationSnapshot.sessionId,
            sessionRevision: conversationSnapshot.sessionRevision,
            modelCallId: randomUUID(),
          },
          conversation: conversationSnapshot,
          systemPrompt: promptLease.systemPrompt,
          tools: input.config.tools,
          model: {
            modelId: input.config.model.modelId,
            contextWindow: input.config.model.contextWindow,
            modelMaxOutputTokens: input.config.model.modelMaxOutputTokens,
            requestedOutputTokens: input.config.model.requestedOutputTokens,
          },
          middleware: input.contextMiddleware,
          progress,
          signal: input.signal,
        }),
      ),
    );
    for await (const event of iterateObserved(observation, () => preparation.progress)) {
      observation.progress({ turn: input.turn, event: cloneData(event) });
      const progressEvent: AgentEvent = { type: "context_progress", event: cloneData(event) };
      yield input.publish(progressEvent);
    }
    preparedContext = await observation.run(() => preparation.result());
    observation.prepared({ turn: input.turn, context: preparedContext });
    observation.complete({});
  } catch (error) {
    if (isAbortError(error, input.signal)) observation.cancel({ error });
    else observation.fail({ error });
    throw error;
  }
  const contextEvent: AgentEvent = {
    type: "model_context_prepared",
    manifest: cloneData(preparedContext.manifest),
  };
  yield input.publish(contextEvent);
  return {
    context: preparedContext,
    environment,
    sessionId: conversationSnapshot.sessionId,
    promptLeaseId: promptLease.id,
  };
}
