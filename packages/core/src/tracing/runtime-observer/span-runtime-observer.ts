import type {
  RuntimeAuthorizationObservation,
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
  NOOP_RUNTIME_AUTHORIZATION_OBSERVATION,
  NOOP_RUNTIME_CONTEXT_OBSERVATION,
  NOOP_RUNTIME_EXECUTION_OBSERVATION,
  NOOP_RUNTIME_MODEL_CALL_OBSERVATION,
  NOOP_RUNTIME_OPERATION_OBSERVATION,
  NOOP_RUNTIME_PREFLIGHT_OBSERVATION,
  NOOP_RUNTIME_RUN_OBSERVATION,
  NOOP_RUNTIME_TOOL_BATCH_OBSERVATION,
  NOOP_RUNTIME_TOOL_CALL_OBSERVATION,
  NOOP_RUNTIME_TURN_OBSERVATION,
  RuntimeObservationTerminal,
  reportRuntimeObservationDiagnostic,
  type RuntimeObservationDiagnosticSink,
} from "../../runtime-observation";
import type { SpanPort, TracerPort } from "../ports";
import { RuntimeSpanName } from "./conventions";
import { completeSpan, failSpan } from "./terminal-state";

export class SpanRuntimeObserver implements RuntimeObserverPort {
  constructor(
    private readonly tracer: TracerPort,
    private readonly diagnostic?: RuntimeObservationDiagnosticSink,
  ) {}

  startRun(fact: Parameters<RuntimeObserverPort["startRun"]>[0]): RuntimeRunObservation {
    return this.safe(
      "start_run",
      () => {
        const span = this.tracer.startSpan(RuntimeSpanName.run, {
          "agent.id": fact.agentId,
          "session.id": fact.sessionId,
          "run.id": fact.runId,
        });
        const terminal = new RuntimeObservationTerminal("span.run", this.diagnostic);
        const finish = (status: "completed" | "error" | "cancelled") => {
          const finishSpan = span.run(() =>
            this.tracer.startSpan(RuntimeSpanName.finish, { "agent.run.status": status }),
          );
          completeSpan(finishSpan, status === "completed" ? "ok" : status);
        };
        return {
          run: (operation) => span.run(operation),
          userInput() {},
          startOperation: (operationFact) =>
            span.run(() => this.operation(operationFact.kind, operationFact.turn)),
          startTurn: (turnFact) => span.run(() => this.turn(turnFact.turn)),
          complete: (completeFact) =>
            terminal.finish("complete", () => {
              const status = completeFact.failure ? "error" : "completed";
              finish(status);
              completeSpan(span, status === "completed" ? "ok" : "error");
            }),
          fail: (failFact) =>
            terminal.finish("fail", () => {
              finish("error");
              failSpan(span, failFact.error);
            }),
          cancel: (cancelFact) =>
            terminal.finish("cancel", () => {
              finish("cancelled");
              failSpan(span, cancelFact.error, "cancelled");
            }),
        };
      },
      NOOP_RUNTIME_RUN_OBSERVATION,
    );
  }

  private operation(
    kind: "environment_capture" | "session_append_input" | "session_persist_output",
    turn?: number,
  ): RuntimeOperationObservation {
    return this.safe(
      "start_operation",
      () => {
        const name =
          kind === "environment_capture"
            ? RuntimeSpanName.environmentCapture
            : kind === "session_append_input"
              ? RuntimeSpanName.sessionAppendInput
              : RuntimeSpanName.sessionPersistOutput;
        const span = this.tracer.startSpan(
          name,
          turn === undefined ? {} : { "agent.turn.index": turn },
        );
        return operationSpan(span, "operation", this.diagnostic);
      },
      NOOP_RUNTIME_OPERATION_OBSERVATION,
    );
  }

  private turn(turn: number): RuntimeTurnObservation {
    return this.safe(
      "start_turn",
      () => {
        const span = this.tracer.startSpan(RuntimeSpanName.turn, { "agent.turn.index": turn });
        const terminal = new RuntimeObservationTerminal("span.turn", this.diagnostic);
        return {
          run: (operation) => span.run(operation),
          startOperation: (fact) => span.run(() => this.operation(fact.kind, fact.turn)),
          startContext: () => span.run(() => this.context(turn)),
          startModelCall: (fact) => span.run(() => this.model(fact)),
          startToolBatch: (fact) => span.run(() => this.batch(fact)),
          finalResponse() {},
          complete: (fact) => terminal.finish("complete", () => completeSpan(span, "ok")),
          fail: (fact) => terminal.finish("fail", () => failSpan(span, fact.failure.message)),
          cancel: (fact) =>
            terminal.finish("cancel", () => failSpan(span, fact.error, "cancelled")),
        };
      },
      NOOP_RUNTIME_TURN_OBSERVATION,
    );
  }

  private context(turn: number): RuntimeContextObservation {
    return this.safe(
      "start_context",
      () => {
        const span = this.tracer.startSpan(RuntimeSpanName.contextPrepare, {
          "agent.turn.index": turn,
        });
        return {
          ...operationSpan(span, "context", this.diagnostic),
          progress() {},
          prepared() {},
        };
      },
      NOOP_RUNTIME_CONTEXT_OBSERVATION,
    );
  }

  private model(
    fact: Parameters<RuntimeTurnObservation["startModelCall"]>[0],
  ): RuntimeModelCallObservation {
    return this.safe(
      "start_model",
      () => {
        const span = this.tracer.startSpan(RuntimeSpanName.modelGenerate, {
          "agent.turn.index": fact.turn,
          "gen_ai.request.model": fact.modelId,
          "gen_ai.input.tokens.estimated": fact.estimatedInputTokens,
        });
        const terminal = new RuntimeObservationTerminal("span.model", this.diagnostic);
        return {
          run: (operation) => span.run(operation),
          requestCaptured() {},
          output() {},
          complete: (completed) =>
            terminal.finish("complete", () => {
              if (completed.timeToFirstEventMs !== undefined) {
                span.setAttribute(
                  "gen_ai.response.time_to_first_event_ms",
                  completed.timeToFirstEventMs,
                );
              }
              span.setAttribute("gen_ai.response.finish_reason", completed.response.stopReason);
              span.setAttribute("gen_ai.usage.input_tokens", completed.usage.inputTokens);
              span.setAttribute("gen_ai.usage.output_tokens", completed.usage.outputTokens);
              completeSpan(span, "ok");
            }),
          fail: (failed) =>
            terminal.finish("fail", () => failSpan(span, failed.error ?? failed.failure.message)),
          cancel: (cancelled) =>
            terminal.finish("cancel", () => failSpan(span, cancelled.error, "cancelled")),
        };
      },
      NOOP_RUNTIME_MODEL_CALL_OBSERVATION,
    );
  }

  private batch(
    fact: Parameters<RuntimeTurnObservation["startToolBatch"]>[0],
  ): RuntimeToolBatchObservation {
    return this.safe(
      "start_tool_batch",
      () => {
        const span = this.tracer.startSpan(RuntimeSpanName.toolBatch, {
          "agent.tool.batch.id": fact.batch.batchId,
          "agent.tool.batch.size": fact.batch.members.length,
        });
        const terminal = new RuntimeObservationTerminal("span.tool_batch", this.diagnostic);
        return {
          run: (operation) => span.run(operation),
          startCall: (callFact) => span.run(() => this.call(callFact)),
          complete: (completed) => terminal.finish("complete", () => completeSpan(span, "ok")),
          fail: (failed) => terminal.finish("fail", () => failSpan(span, failed.error)),
          cancel: (cancelled) =>
            terminal.finish("cancel", () => failSpan(span, cancelled.error, "cancelled")),
        };
      },
      NOOP_RUNTIME_TOOL_BATCH_OBSERVATION,
    );
  }

  private call(
    fact: Parameters<RuntimeToolBatchObservation["startCall"]>[0],
  ): RuntimeToolCallObservation {
    return this.safe(
      "start_tool_call",
      () => {
        const span = this.tracer.startSpan(RuntimeSpanName.toolCall, {
          "agent.tool.name": fact.toolName,
          "agent.tool.call.id": fact.toolCallId,
          ...(fact.batchId ? { "agent.tool.batch.id": fact.batchId } : {}),
        });
        const terminal = new RuntimeObservationTerminal("span.tool_call", this.diagnostic);
        return {
          run: (operation) => span.run(operation),
          startPreflight: (preflight) => span.run(() => this.preflight(preflight)),
          startAuthorization: (authorization) => span.run(() => this.authorization(authorization)),
          startExecution: (execution) => span.run(() => this.execution(execution)),
          result() {},
          complete: (completed) =>
            terminal.finish("complete", () =>
              completeSpan(span, completed.result.isError ? "error" : "ok"),
            ),
          deny: (denied) => terminal.finish("deny", () => completeSpan(span, "denied")),
          fail: (failed) => terminal.finish("fail", () => failSpan(span, failed.error)),
          cancel: (cancelled) =>
            terminal.finish("cancel", () => failSpan(span, cancelled.error, "cancelled")),
        };
      },
      NOOP_RUNTIME_TOOL_CALL_OBSERVATION,
    );
  }

  private preflight(
    fact: Parameters<RuntimeToolCallObservation["startPreflight"]>[0],
  ): RuntimePreflightObservation {
    return this.safe(
      "start_preflight",
      () => {
        const span = this.tracer.startSpan(RuntimeSpanName.toolPreflight, {
          "agent.tool.name": fact.toolName,
        });
        const terminal = new RuntimeObservationTerminal("span.preflight", this.diagnostic);
        return {
          run: (operation) => span.run(operation),
          complete: (completed) =>
            terminal.finish("complete", () =>
              completeSpan(span, completed.outcome === "error" ? "error" : "ok"),
            ),
          fail: (failed) => terminal.finish("fail", () => failSpan(span, failed.error)),
          cancel: (cancelled) =>
            terminal.finish("cancel", () => failSpan(span, cancelled.error, "cancelled")),
        };
      },
      NOOP_RUNTIME_PREFLIGHT_OBSERVATION,
    );
  }

  private authorization(
    fact: Parameters<RuntimeToolCallObservation["startAuthorization"]>[0],
  ): RuntimeAuthorizationObservation {
    return this.safe(
      "start_authorization",
      () => {
        const span = this.tracer.startSpan(RuntimeSpanName.toolAuthorization, {
          "agent.tool.name": fact.toolName,
        });
        const terminal = new RuntimeObservationTerminal("span.authorization", this.diagnostic);
        return {
          run: (operation) => span.run(operation),
          complete: (completed) => terminal.finish("complete", () => completeSpan(span, "ok")),
          deny: (denied) => terminal.finish("deny", () => completeSpan(span, "denied")),
          fail: (failed) => terminal.finish("fail", () => failSpan(span, failed.error)),
          cancel: (cancelled) =>
            terminal.finish("cancel", () => failSpan(span, cancelled.error, "cancelled")),
        };
      },
      NOOP_RUNTIME_AUTHORIZATION_OBSERVATION,
    );
  }

  private execution(
    fact: Parameters<RuntimeToolCallObservation["startExecution"]>[0],
  ): RuntimeExecutionObservation {
    return this.safe(
      "start_execution",
      () => {
        const span = this.tracer.startSpan(RuntimeSpanName.toolExecution, {
          "agent.tool.name": fact.toolName,
          ...(fact.toolCallId ? { "agent.tool.call.id": fact.toolCallId } : {}),
        });
        const terminal = new RuntimeObservationTerminal("span.execution", this.diagnostic);
        return {
          run: (operation) => span.run(operation),
          complete: (completed) =>
            terminal.finish("complete", () =>
              completeSpan(span, completed.result.isError ? "error" : "ok"),
            ),
          timeout: (timedOut) =>
            terminal.finish("timeout", () => failSpan(span, timedOut.error, "timed_out")),
          fail: (failed) => terminal.finish("fail", () => failSpan(span, failed.error)),
          cancel: (cancelled) =>
            terminal.finish("cancel", () => failSpan(span, cancelled.error, "cancelled")),
        };
      },
      NOOP_RUNTIME_EXECUTION_OBSERVATION,
    );
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

function operationSpan(
  span: SpanPort,
  scope: string,
  diagnostic?: RuntimeObservationDiagnosticSink,
): RuntimeOperationObservation {
  const terminal = new RuntimeObservationTerminal(`span.${scope}`, diagnostic);
  return {
    run: (operation) => span.run(operation),
    complete: (fact) => terminal.finish("complete", () => completeSpan(span, "ok")),
    fail: (fact) => terminal.finish("fail", () => failSpan(span, fact.error)),
    cancel: (fact) => terminal.finish("cancel", () => failSpan(span, fact.error, "cancelled")),
  };
}
