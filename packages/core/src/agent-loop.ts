import type { StreamSession } from "./stream/index";
import { throwIfAborted } from "./execution";
import { createLoopProtection } from "./loop-protection";
import { WorkingConversation } from "./agent/workingConversation";
import { runLoopIteration } from "./agent/loop/orchestrator";
import { maxTurnsFailure } from "./agent/loop/failures";
import { NOOP_RUNTIME_RUN_OBSERVATION } from "./runtime-observation";
import type { AgentEvent, AgentLoopInput, TokenUsage } from "./types";
import { isAbortError } from "./execution";
import { runtimeFailure } from "./agent/loop/failures";
import { dispatchPostEventHooks } from "./hooks";

export interface AgentLoopOptions {
  /** Optional StreamSession for state-machine-driven event dispatch */
  session?: StreamSession;
}

/**
 * Run the agent loop as an async generator.
 *
 * The caller provides a detached Session transcript snapshot. The loop appends assistant and
 * tool-result messages internally and returns them through the final event's `produced` field.
 * When a StreamSession is provided, events are also dispatched through its state machine.
 *
 * This is the Run-level orchestrator. It owns iteration and terminal Run events while
 * the internal loop-iteration orchestrator owns phase ordering and scoped lifecycle completion.
 */
export async function* runAgentLoop(input: AgentLoopInput): AsyncGenerator<AgentEvent> {
  const conversation = WorkingConversation.from(input.snapshot);
  for await (const event of runIterations(input, conversation)) {
    // Dispatch before yielding: consumers may stop reading as soon as a terminal event arrives.
    if (event.type === "done" || event.type === "error") {
      await dispatchPostEventHooks(
        event.type === "done"
          ? { type: "run.completed", usage: event.usage }
          : { type: "run.failed", failure: event.failure },
        {
          config: input.config,
          coordinator: input.toolCallCoordinator,
          environment: {
            agentId: input.agentId,
            workspaceId: input.workspaceId,
            workspaceRoot: input.workspaceRoot,
            cwd: conversation.snapshot().environment?.snapshot.workspace.cwd ?? input.workspaceRoot,
            middleware: input.config.middleware ?? [],
            lifecycleAdapters: input.config.toolLifecycleAdapters ?? [],
            origin: "hook",
          },
          signal: input.signal,
        },
      );
    }
    yield event;
  }
}

async function* runIterations(
  input: AgentLoopInput,
  conversation: WorkingConversation,
): AsyncGenerator<AgentEvent> {
  const maxTurns = input.config.maxTurns;
  const session = input.options?.session;
  const loopProtection = createLoopProtection();
  const runObservation = input.observation ?? NOOP_RUNTIME_RUN_OBSERVATION;
  let lastUsage: TokenUsage | undefined;

  try {
    for (const policy of input.config.toolBatchPreparationPolicies ?? []) {
      await policy.beginRun?.();
    }
    for (let turn = 0; maxTurns === undefined || turn < maxTurns; turn++) {
      throwIfAborted(input.signal);
      const result = yield* runLoopIteration({
        turn,
        maxTurns,
        lastUsage,
        agentId: input.agentId,
        workspaceId: input.workspaceId,
        workspaceRoot: input.workspaceRoot,
        config: input.config,
        conversation,
        environmentContext: input.environmentContext,
        contextEngine: input.contextEngine,
        contextMiddleware: input.contextMiddleware,
        modelRuntime: input.modelRuntime,
        toolCallCoordinator: input.toolCallCoordinator,
        loopProtection,
        runObservation,
        session,
        signal: input.signal,
      });
      lastUsage = result.usage;
      if (result.kind === "completed" || result.kind === "failed") return;
      if (result.kind === "max_turns") {
        yield maxTurnsEvent(result.maxTurns, conversation, session, lastUsage);
        return;
      }
    }

    if (maxTurns !== undefined) yield maxTurnsEvent(maxTurns, conversation, session, lastUsage);
  } catch (error) {
    if (isAbortError(error, input.signal)) throw error;
    const failure = runtimeFailure("agent_run_failed", error, false);
    session?.handle({ type: "error", failure });
    yield { type: "error", failure, produced: conversation.produced(), usage: lastUsage };
  }
}

function maxTurnsEvent(
  maxTurns: number,
  conversation: WorkingConversation,
  session: StreamSession | undefined,
  usage: TokenUsage | undefined,
): Extract<AgentEvent, { type: "error" }> {
  const failure = maxTurnsFailure(maxTurns);
  session?.handle({ type: "error", failure });
  return {
    type: "error",
    failure,
    produced: conversation.produced(),
    usage,
    turnCount: maxTurns,
    maxTurns,
  };
}
