import { cloneData } from "../../dataCopy";
import type {
  RuntimeAccessObservation,
  RuntimeContextObservation,
  RuntimeExecutionObservation,
  RuntimeModelCallObservation,
  RuntimeObserverPort,
  RuntimeOperationObservation,
  RuntimePreflightObservation,
  RuntimeRunObservation,
  RuntimeToolBatchObservation,
  RuntimeToolCallObservation,
  RuntimeTurnObservation,
} from "../../runtime-observation";
import {
  NOOP_RUNTIME_OPERATION_OBSERVATION,
  NOOP_RUNTIME_RUN_OBSERVATION,
  RuntimeObservationTerminal,
  reportRuntimeObservationDiagnostic,
  type RuntimeObservationDiagnosticSink,
} from "../../runtime-observation";
import type { ReplaySinkPort } from "../ports";
import { modelRequestReplayInput } from "./model-request";

const transparent = <T>(operation: () => T): T => operation();

export class ReplayRuntimeObserver implements RuntimeObserverPort {
  constructor(
    private readonly replay: ReplaySinkPort,
    private readonly diagnostic?: RuntimeObservationDiagnosticSink,
  ) {}

  startRun(): RuntimeRunObservation {
    return this.safe(
      "start_run",
      () => {
        this.record({ kind: "run.started" });
        const terminal = new RuntimeObservationTerminal("replay.run", this.diagnostic);
        return {
          run: transparent,
          userInput: (fact) => this.record({ kind: "user.input", payload: cloneData(fact) }),
          startOperation: () => NOOP_RUNTIME_OPERATION_OBSERVATION,
          startTurn: (fact) => this.turn(fact.turn),
          complete: (fact) =>
            terminal.finish("complete", () =>
              this.record({
                kind: fact.failure ? "run.failed" : "run.completed",
                payload: cloneData({
                  ...(fact.usage ? { usage: fact.usage } : {}),
                  ...(fact.failure ? { failure: fact.failure } : {}),
                }),
              }),
            ),
          fail: (fact) =>
            terminal.finish("fail", () =>
              this.record({ kind: "run.failed", payload: { failure: cloneData(fact.failure) } }),
            ),
          cancel: (fact) =>
            terminal.finish("cancel", () =>
              this.record({ kind: "run.cancelled", payload: { failure: cloneData(fact.failure) } }),
            ),
        };
      },
      NOOP_RUNTIME_RUN_OBSERVATION,
    );
  }

  private turn(turn: number): RuntimeTurnObservation {
    this.record({ kind: "turn.started", payload: { turn } });
    const terminal = new RuntimeObservationTerminal("replay.turn", this.diagnostic);
    return {
      run: transparent,
      startOperation: () => NOOP_RUNTIME_OPERATION_OBSERVATION,
      startContext: () => this.context(turn),
      startModelCall: (fact) => this.model(turn, fact.modelCallId, fact.modelId),
      startToolBatch: (fact) => this.batch(turn, fact.batch),
      finalResponse: (fact) =>
        this.record({
          kind: "agent.final_response",
          correlation: { modelCallId: fact.modelCallId },
          payload: { turn },
        }),
      complete: (fact) =>
        terminal.finish("complete", () =>
          this.record({ kind: "turn.completed", payload: cloneData(fact) }),
        ),
      fail: (fact) =>
        terminal.finish("fail", () =>
          this.record({
            kind: "turn.failed",
            payload: { turn, event: { type: "error", failure: cloneData(fact.failure) } },
          }),
        ),
      cancel: (fact) =>
        terminal.finish("cancel", () => this.record({ kind: "turn.cancelled", payload: { turn } })),
    };
  }

  private context(turn: number): RuntimeContextObservation {
    const terminal = new RuntimeObservationTerminal("replay.context", this.diagnostic);
    return {
      run: transparent,
      progress: (fact) =>
        this.record({
          kind: "context.progress",
          payload: {
            turn,
            event: { type: "context_progress", event: cloneData(fact.event) },
          },
        }),
      prepared: (fact) =>
        this.record({
          kind: "context.prepared",
          payload: {
            turn,
            event: {
              type: "model_context_prepared",
              manifest: cloneData(fact.context.manifest),
            },
          },
        }),
      complete: () => terminal.finish("complete", () => undefined),
      fail: (fact) =>
        terminal.finish("fail", () =>
          this.record({
            kind: "context.failed",
            payload: { turn, error: errorMessage(fact.error) },
          }),
        ),
      cancel: (fact) =>
        terminal.finish("cancel", () =>
          this.record({
            kind: "context.cancelled",
            payload: { turn, ...(fact.error ? { error: errorMessage(fact.error) } : {}) },
          }),
        ),
    };
  }

  private model(turn: number, modelCallId: string, modelId: string): RuntimeModelCallObservation {
    const terminal = new RuntimeObservationTerminal("replay.model", this.diagnostic);
    return {
      run: transparent,
      requestCaptured: (fact) => {
        this.record(modelRequestReplayInput(fact));
        this.record({
          kind: "model.started",
          correlation: { modelCallId },
          payload: { modelId, turn },
        });
      },
      output: (fact) => {
        const event = modelOutputEvent(fact);
        const correlatedModelCallId =
          fact.kind === "cache_reported" ? fact.report.modelCallId : fact.modelCallId;
        this.record({
          kind: modelOutputKind(fact.kind),
          correlation: { modelCallId: correlatedModelCallId },
          payload: { turn, event },
        });
      },
      complete: (fact) =>
        terminal.finish("complete", () =>
          this.record({
            kind: "model.completed",
            correlation: { modelCallId },
            payload: {
              stopReason: fact.response.stopReason,
              usage: cloneData(fact.response.usage),
            },
          }),
        ),
      fail: (fact) =>
        terminal.finish("fail", () =>
          this.record({
            kind: "model.failed",
            correlation: { modelCallId },
            payload: { failure: cloneData(fact.failure) },
          }),
        ),
      cancel: (fact) =>
        terminal.finish("cancel", () =>
          this.record({
            kind: "model.cancelled",
            correlation: { modelCallId },
            ...(fact.error ? { payload: { error: errorMessage(fact.error) } } : {}),
          }),
        ),
    };
  }

  private batch(
    turn: number,
    batch: Parameters<RuntimeTurnObservation["startToolBatch"]>[0]["batch"],
  ): RuntimeToolBatchObservation {
    const terminal = new RuntimeObservationTerminal("replay.tool_batch", this.diagnostic);
    this.record({
      kind: "tool.batch.started",
      correlation: { modelCallId: batch.modelCallId, batchId: batch.batchId },
      payload: { turn, event: { type: "tool_batch_started", batch: cloneData(batch) } },
    });
    return {
      run: transparent,
      startCall: (fact) => this.call(fact),
      complete: (fact) =>
        terminal.finish("complete", () =>
          this.record({
            kind: "tool.batch.completed",
            correlation: { modelCallId: fact.modelCallId, batchId: fact.batchId },
            payload: { turn, event: { type: "tool_batch_completed", ...cloneData(fact) } },
          }),
        ),
      fail: (fact) =>
        terminal.finish("fail", () =>
          this.record({
            kind: "tool.batch.failed",
            correlation: { modelCallId: batch.modelCallId, batchId: batch.batchId },
            payload: { error: errorMessage(fact.error) },
          }),
        ),
      cancel: (fact) =>
        terminal.finish("cancel", () =>
          this.record({
            kind: "tool.batch.cancelled",
            correlation: { modelCallId: batch.modelCallId, batchId: batch.batchId },
            ...(fact.error ? { payload: { error: errorMessage(fact.error) } } : {}),
          }),
        ),
    };
  }

  private call(
    fact: Parameters<RuntimeToolBatchObservation["startCall"]>[0],
  ): RuntimeToolCallObservation {
    const terminal = new RuntimeObservationTerminal("replay.tool_call", this.diagnostic);
    const correlation = {
      toolCallId: fact.toolCallId,
      ...(fact.batchId ? { batchId: fact.batchId } : {}),
    };
    this.record({
      kind: "tool.call.started",
      correlation,
      payload: { toolName: fact.toolName, input: cloneData(fact.input) },
      ...(fact.hiddenInputKeys ? { hiddenKeys: fact.hiddenInputKeys } : {}),
    });
    return {
      run: transparent,
      startPreflight: () => this.preflight(fact.toolCallId),
      startAccess: () => this.access(fact.toolCallId),
      startExecution: (execution) => this.execution(execution),
      result: (result) =>
        this.record({
          kind: "tool.result",
          correlation: {
            toolCallId: result.toolCallId,
            ...(result.batchId ? { batchId: result.batchId } : {}),
          },
          payload: { result: cloneData(result.result), metrics: cloneData(result.metrics) },
        }),
      complete: () => terminal.finish("complete", () => undefined),
      deny: () => terminal.finish("deny", () => undefined),
      fail: (failed) =>
        terminal.finish("fail", () =>
          this.record({
            kind: "tool.call.failed",
            correlation,
            payload: { error: errorMessage(failed.error) },
          }),
        ),
      cancel: (cancelled) =>
        terminal.finish("cancel", () =>
          this.record({
            kind: "tool.call.cancelled",
            correlation,
            ...(cancelled.error ? { payload: { error: errorMessage(cancelled.error) } } : {}),
          }),
        ),
    };
  }

  private preflight(toolCallId: string): RuntimePreflightObservation {
    const terminal = new RuntimeObservationTerminal("replay.preflight", this.diagnostic);
    return {
      run: transparent,
      complete: (fact) =>
        terminal.finish("complete", () =>
          this.record({
            kind: "tool.preflight.completed",
            correlation: { toolCallId },
            payload: { outcome: fact.outcome },
          }),
        ),
      fail: (fact) =>
        terminal.finish("fail", () =>
          this.record({
            kind: "tool.preflight.failed",
            correlation: { toolCallId },
            payload: { error: errorMessage(fact.error) },
          }),
        ),
      cancel: (fact) =>
        terminal.finish("cancel", () =>
          this.record({
            kind: "tool.preflight.cancelled",
            correlation: { toolCallId },
            ...(fact.error ? { payload: { error: errorMessage(fact.error) } } : {}),
          }),
        ),
    };
  }

  private access(toolCallId: string): RuntimeAccessObservation {
    const terminal = new RuntimeObservationTerminal("replay.access", this.diagnostic);
    return {
      run: transparent,
      complete: (fact) =>
        terminal.finish("complete", () =>
          this.record({
            kind: "tool.access.completed",
            correlation: { toolCallId },
            payload: { outcome: fact.outcome, accessMs: fact.accessMs },
          }),
        ),
      deny: (fact) =>
        terminal.finish("deny", () =>
          this.record({
            kind: "tool.access.completed",
            correlation: { toolCallId },
            payload: { outcome: "denied", accessMs: fact.accessMs },
          }),
        ),
      fail: (fact) =>
        terminal.finish("fail", () =>
          this.record({
            kind: "tool.access.failed",
            correlation: { toolCallId },
            payload: { error: errorMessage(fact.error) },
          }),
        ),
      cancel: (fact) =>
        terminal.finish("cancel", () =>
          this.record({
            kind: "tool.access.cancelled",
            correlation: { toolCallId },
            ...(fact.error ? { payload: { error: errorMessage(fact.error) } } : {}),
          }),
        ),
    };
  }

  private execution(
    fact: Parameters<RuntimeToolCallObservation["startExecution"]>[0],
  ): RuntimeExecutionObservation {
    const terminal = new RuntimeObservationTerminal("replay.execution", this.diagnostic);
    const correlation = {
      ...(fact.toolCallId ? { toolCallId: fact.toolCallId } : {}),
      ...(fact.batchId ? { batchId: fact.batchId } : {}),
    };
    this.record({
      kind: "tool.execution.started",
      correlation,
      payload: { toolName: fact.toolName },
    });
    const completed = (
      kind: "tool.execution.completed" | "tool.execution.timed_out",
      value:
        | Parameters<RuntimeExecutionObservation["complete"]>[0]
        | Parameters<RuntimeExecutionObservation["timeout"]>[0],
    ) =>
      this.record({
        kind,
        correlation,
        payload: {
          toolName: value.toolName,
          result: cloneData(value.result),
          executionMs: value.executionMs,
          ...("error" in value ? { error: errorMessage(value.error) } : {}),
        },
      });
    return {
      run: transparent,
      complete: (fact) =>
        terminal.finish("complete", () => completed("tool.execution.completed", fact)),
      timeout: (fact) =>
        terminal.finish("timeout", () => completed("tool.execution.timed_out", fact)),
      fail: (fact) =>
        terminal.finish("fail", () =>
          this.record({
            kind: "tool.execution.failed",
            correlation,
            payload: { error: errorMessage(fact.error) },
          }),
        ),
      cancel: (fact) =>
        terminal.finish("cancel", () =>
          this.record({
            kind: "tool.execution.cancelled",
            correlation,
            payload: {
              ...(fact.error ? { error: errorMessage(fact.error) } : {}),
              ...(fact.output ? { output: fact.output } : {}),
              ...(fact.outputPersistenceFailure
                ? { outputPersistenceFailure: fact.outputPersistenceFailure }
                : {}),
            },
          }),
        ),
    };
  }

  private record(event: Parameters<ReplaySinkPort["record"]>[0]): void {
    try {
      this.replay.record(event);
    } catch (error) {
      reportRuntimeObservationDiagnostic(this.diagnostic, "record_replay", error);
    }
  }

  private safe<T>(operation: string, create: () => T, fallback: T): T {
    try {
      return create();
    } catch (error) {
      reportRuntimeObservationDiagnostic(this.diagnostic, operation, error);
      return fallback;
    }
  }
}

function modelOutputKind(
  kind: Parameters<RuntimeModelCallObservation["output"]>[0]["kind"],
): string {
  switch (kind) {
    case "text_delta":
      return "model.text.delta";
    case "thinking_started":
      return "model.thinking.started";
    case "thinking_delta":
      return "model.thinking.delta";
    case "thinking_completed":
      return "model.thinking.completed";
    case "tool_constraints_reported":
      return "model.tool_constraints.reported";
    case "cache_reported":
      return "model.cache.reported";
  }
}

function modelOutputEvent(
  fact: Parameters<RuntimeModelCallObservation["output"]>[0],
): Record<string, unknown> {
  switch (fact.kind) {
    case "text_delta": {
      const { kind: _kind, ...event } = cloneData(fact);
      return { type: "text_delta", ...event };
    }
    case "thinking_started":
      return {
        type: "thinking_start",
        modelCallId: fact.modelCallId,
        contentIndex: fact.contentIndex,
      };
    case "thinking_delta":
      return {
        type: "thinking_delta",
        modelCallId: fact.modelCallId,
        contentIndex: fact.contentIndex,
        delta: fact.delta,
      };
    case "thinking_completed":
      return {
        type: "thinking_end",
        modelCallId: fact.modelCallId,
        contentIndex: fact.contentIndex,
        content: fact.content,
      };
    case "tool_constraints_reported":
      return { type: "tool_constraint_report", report: cloneData(fact.report) };
    case "cache_reported":
      return { type: "model_cache_report", report: cloneData(fact.report) };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
