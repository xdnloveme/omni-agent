import {
  reportRuntimeObservationDiagnostic,
  type RuntimeObservationDiagnosticSink,
} from "./diagnostics";
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
} from "./noop";
import type {
  RuntimeAuthorizationObservation,
  RuntimeContextObservation,
  RuntimeExecutionObservation,
  RuntimeModelCallObservation,
  RuntimeObservationScope,
  RuntimeObserverPort,
  RuntimeOperationObservation,
  RuntimePreflightObservation,
  RuntimeRunObservation,
  RuntimeToolBatchObservation,
  RuntimeToolCallObservation,
  RuntimeTurnObservation,
} from "./ports";
import { RuntimeObservationTerminal } from "./terminal";

export class CompositeRuntimeObserver implements RuntimeObserverPort {
  private readonly observers: readonly RuntimeObserverPort[];

  constructor(
    observers: readonly RuntimeObserverPort[],
    private readonly diagnostic?: RuntimeObservationDiagnosticSink,
  ) {
    this.observers = [...observers];
  }

  startRun(fact: Parameters<RuntimeObserverPort["startRun"]>[0]): RuntimeRunObservation {
    return runObservation(
      children(this.observers, "startRun", fact, NOOP_RUNTIME_RUN_OBSERVATION, this.diagnostic),
      this.diagnostic,
    );
  }
}

function runObservation(
  targets: readonly RuntimeRunObservation[],
  diagnostic?: RuntimeObservationDiagnosticSink,
): RuntimeRunObservation {
  const [scope, terminal] = terminalScope(targets, "run", diagnostic);
  return {
    ...scope,
    userInput: (fact) => {
      if (terminal.allows("userInput")) broadcast(targets, "userInput", fact, diagnostic);
    },
    startOperation: (fact) =>
      terminal.allows("startOperation")
        ? operationObservation(
            children(
              targets,
              "startOperation",
              fact,
              NOOP_RUNTIME_OPERATION_OBSERVATION,
              diagnostic,
            ),
            diagnostic,
          )
        : NOOP_RUNTIME_OPERATION_OBSERVATION,
    startTurn: (fact) =>
      terminal.allows("startTurn")
        ? turnObservation(
            children(targets, "startTurn", fact, NOOP_RUNTIME_TURN_OBSERVATION, diagnostic),
            diagnostic,
          )
        : NOOP_RUNTIME_TURN_OBSERVATION,
  };
}

function operationObservation(
  targets: readonly RuntimeOperationObservation[],
  diagnostic?: RuntimeObservationDiagnosticSink,
): RuntimeOperationObservation {
  return terminalScope(targets, "operation", diagnostic)[0];
}

function contextObservation(
  targets: readonly RuntimeContextObservation[],
  diagnostic?: RuntimeObservationDiagnosticSink,
): RuntimeContextObservation {
  const [scope, terminal] = terminalScope(targets, "context", diagnostic);
  return {
    ...scope,
    progress: (fact) => {
      if (terminal.allows("progress")) broadcast(targets, "progress", fact, diagnostic);
    },
    prepared: (fact) => {
      if (terminal.allows("prepared")) broadcast(targets, "prepared", fact, diagnostic);
    },
  };
}

function turnObservation(
  targets: readonly RuntimeTurnObservation[],
  diagnostic?: RuntimeObservationDiagnosticSink,
): RuntimeTurnObservation {
  const [scope, terminal] = terminalScope(targets, "turn", diagnostic);
  return {
    ...scope,
    startOperation: (fact) =>
      terminal.allows("startOperation")
        ? operationObservation(
            children(
              targets,
              "startOperation",
              fact,
              NOOP_RUNTIME_OPERATION_OBSERVATION,
              diagnostic,
            ),
            diagnostic,
          )
        : NOOP_RUNTIME_OPERATION_OBSERVATION,
    startContext: (fact) =>
      terminal.allows("startContext")
        ? contextObservation(
            children(targets, "startContext", fact, NOOP_RUNTIME_CONTEXT_OBSERVATION, diagnostic),
            diagnostic,
          )
        : NOOP_RUNTIME_CONTEXT_OBSERVATION,
    startModelCall: (fact) =>
      terminal.allows("startModelCall")
        ? modelObservation(
            children(
              targets,
              "startModelCall",
              fact,
              NOOP_RUNTIME_MODEL_CALL_OBSERVATION,
              diagnostic,
            ),
            diagnostic,
          )
        : NOOP_RUNTIME_MODEL_CALL_OBSERVATION,
    startToolBatch: (fact) =>
      terminal.allows("startToolBatch")
        ? batchObservation(
            children(
              targets,
              "startToolBatch",
              fact,
              NOOP_RUNTIME_TOOL_BATCH_OBSERVATION,
              diagnostic,
            ),
            diagnostic,
          )
        : NOOP_RUNTIME_TOOL_BATCH_OBSERVATION,
    finalResponse: (fact) => {
      if (terminal.allows("finalResponse")) {
        broadcast(targets, "finalResponse", fact, diagnostic);
      }
    },
  };
}

function modelObservation(
  targets: readonly RuntimeModelCallObservation[],
  diagnostic?: RuntimeObservationDiagnosticSink,
): RuntimeModelCallObservation {
  const [scope, terminal] = terminalScope(targets, "model", diagnostic);
  return {
    ...scope,
    requestCaptured: (fact) => {
      if (terminal.allows("requestCaptured")) {
        broadcast(targets, "requestCaptured", fact, diagnostic);
      }
    },
    output: (fact) => {
      if (terminal.allows("output")) broadcast(targets, "output", fact, diagnostic);
    },
  };
}

function batchObservation(
  targets: readonly RuntimeToolBatchObservation[],
  diagnostic?: RuntimeObservationDiagnosticSink,
): RuntimeToolBatchObservation {
  const [scope, terminal] = terminalScope(targets, "tool_batch", diagnostic);
  return {
    ...scope,
    startCall: (fact) =>
      terminal.allows("startCall")
        ? callObservation(
            children(targets, "startCall", fact, NOOP_RUNTIME_TOOL_CALL_OBSERVATION, diagnostic),
            diagnostic,
          )
        : NOOP_RUNTIME_TOOL_CALL_OBSERVATION,
  };
}

function callObservation(
  targets: readonly RuntimeToolCallObservation[],
  diagnostic?: RuntimeObservationDiagnosticSink,
): RuntimeToolCallObservation {
  const [scope, terminal] = terminalScope(targets, "tool_call", diagnostic);
  return {
    ...scope,
    startPreflight: (fact) =>
      terminal.allows("startPreflight")
        ? preflightObservation(
            children(
              targets,
              "startPreflight",
              fact,
              NOOP_RUNTIME_PREFLIGHT_OBSERVATION,
              diagnostic,
            ),
            diagnostic,
          )
        : NOOP_RUNTIME_PREFLIGHT_OBSERVATION,
    startAuthorization: (fact) =>
      terminal.allows("startAuthorization")
        ? authorizationObservation(
            children(
              targets,
              "startAuthorization",
              fact,
              NOOP_RUNTIME_AUTHORIZATION_OBSERVATION,
              diagnostic,
            ),
            diagnostic,
          )
        : NOOP_RUNTIME_AUTHORIZATION_OBSERVATION,
    startExecution: (fact) =>
      terminal.allows("startExecution")
        ? executionObservation(
            children(
              targets,
              "startExecution",
              fact,
              NOOP_RUNTIME_EXECUTION_OBSERVATION,
              diagnostic,
            ),
            diagnostic,
          )
        : NOOP_RUNTIME_EXECUTION_OBSERVATION,
    result: (fact) => {
      if (terminal.allows("result")) broadcast(targets, "result", fact, diagnostic);
    },
    deny: (fact) => terminal.finish("deny", () => broadcast(targets, "deny", fact, diagnostic)),
  };
}

function preflightObservation(
  targets: readonly RuntimePreflightObservation[],
  diagnostic?: RuntimeObservationDiagnosticSink,
): RuntimePreflightObservation {
  return terminalScope(targets, "preflight", diagnostic)[0];
}

function authorizationObservation(
  targets: readonly RuntimeAuthorizationObservation[],
  diagnostic?: RuntimeObservationDiagnosticSink,
): RuntimeAuthorizationObservation {
  const [scope, terminal] = terminalScope(targets, "authorization", diagnostic);
  return {
    ...scope,
    deny: (fact) => terminal.finish("deny", () => broadcast(targets, "deny", fact, diagnostic)),
  };
}

function executionObservation(
  targets: readonly RuntimeExecutionObservation[],
  diagnostic?: RuntimeObservationDiagnosticSink,
): RuntimeExecutionObservation {
  const [scope, terminal] = terminalScope(targets, "execution", diagnostic);
  return {
    ...scope,
    timeout: (fact) =>
      terminal.finish("timeout", () => broadcast(targets, "timeout", fact, diagnostic)),
  };
}

function terminalScope<T extends RuntimeObservationScope>(
  targets: readonly T[],
  name: string,
  diagnostic?: RuntimeObservationDiagnosticSink,
): readonly [CompositeTerminalScope, RuntimeObservationTerminal] {
  const terminal = new RuntimeObservationTerminal(name, diagnostic);
  return [
    {
      run: (operation) => runInScopes(targets, operation, diagnostic),
      complete: (fact) =>
        terminal.finish("complete", () => broadcast(targets, "complete", fact, diagnostic)),
      fail: (fact) => terminal.finish("fail", () => broadcast(targets, "fail", fact, diagnostic)),
      cancel: (fact) =>
        terminal.finish("cancel", () => broadcast(targets, "cancel", fact, diagnostic)),
    },
    terminal,
  ];
}

function children<T, F, C>(
  targets: readonly T[],
  method: PropertyKey,
  fact: F,
  fallback: C,
  diagnostic?: RuntimeObservationDiagnosticSink,
): C[] {
  return targets.map((target) => {
    try {
      const invoke = (target as unknown as Record<PropertyKey, unknown>)[method] as (value: F) => C;
      return invoke.call(target, fact);
    } catch (error) {
      reportRuntimeObservationDiagnostic(diagnostic, String(method), error);
      return fallback;
    }
  });
}

function broadcast<T>(
  targets: readonly T[],
  method: PropertyKey,
  fact: unknown,
  diagnostic?: RuntimeObservationDiagnosticSink,
): void {
  for (const target of targets) {
    try {
      const invoke = (target as unknown as Record<PropertyKey, unknown>)[method] as (
        value: unknown,
      ) => void;
      invoke.call(target, fact);
    } catch (error) {
      reportRuntimeObservationDiagnostic(diagnostic, String(method), error);
    }
  }
}

interface CompositeTerminalScope extends RuntimeObservationScope {
  complete(fact: unknown): void;
  fail(fact: unknown): void;
  cancel(fact: unknown): void;
}

function runInScopes<T>(
  targets: readonly RuntimeObservationScope[],
  operation: () => T,
  diagnostic?: RuntimeObservationDiagnosticSink,
): T {
  const invoke = (index: number): T => {
    if (index === targets.length) return operation();
    let operationAvailable = true;
    let operationStarted = false;
    let operationCompleted = false;
    let operationThrew = false;
    let operationError: unknown;
    let operationResult: T | undefined;
    try {
      const wrapperResult = targets[index]!.run(() => {
        if (!operationAvailable) {
          reportRuntimeObservationDiagnostic(
            diagnostic,
            "run",
            new Error("Runtime observer invoked the operation after its scope returned"),
          );
          return operationResult as T;
        }
        if (operationStarted) {
          reportRuntimeObservationDiagnostic(
            diagnostic,
            "run",
            new Error("Runtime observer invoked the operation more than once"),
          );
          return operationResult as T;
        }
        operationStarted = true;
        try {
          operationResult = invoke(index + 1);
          operationCompleted = true;
          return operationResult;
        } catch (error) {
          operationThrew = true;
          operationError = error;
          throw error;
        }
      });
      if (operationThrew) throw operationError;
      if (!operationStarted) {
        reportRuntimeObservationDiagnostic(
          diagnostic,
          "run",
          new Error("Runtime observer did not invoke the operation"),
        );
        return invoke(index + 1);
      }
      if (!Object.is(wrapperResult, operationResult)) {
        reportRuntimeObservationDiagnostic(
          diagnostic,
          "run",
          new Error("Runtime observer changed the operation result"),
        );
      }
      return operationResult as T;
    } catch (error) {
      if (operationThrew) throw operationError;
      reportRuntimeObservationDiagnostic(diagnostic, "run", error);
      if (operationStarted && operationCompleted) return operationResult as T;
      return invoke(index + 1);
    } finally {
      operationAvailable = false;
    }
  };
  return invoke(0);
}
