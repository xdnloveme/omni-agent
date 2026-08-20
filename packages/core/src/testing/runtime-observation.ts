import {
  NOOP_RUNTIME_AUTHORIZATION_OBSERVATION,
  NOOP_RUNTIME_CONTEXT_OBSERVATION,
  NOOP_RUNTIME_EXECUTION_OBSERVATION,
  NOOP_RUNTIME_MODEL_CALL_OBSERVATION,
  NOOP_RUNTIME_OPERATION_OBSERVATION,
  NOOP_RUNTIME_PREFLIGHT_OBSERVATION,
  NOOP_RUNTIME_TOOL_BATCH_OBSERVATION,
  NOOP_RUNTIME_TOOL_CALL_OBSERVATION,
  NOOP_RUNTIME_TURN_OBSERVATION,
  type RuntimeObserverPort,
  type RuntimeRunObservation,
} from "../runtime-observation";

export interface RecordedRuntimeObservation {
  readonly operation: string;
  readonly fact: unknown;
}

export class RecordingRuntimeObserver implements RuntimeObserverPort {
  readonly records: RecordedRuntimeObservation[] = [];

  startRun(fact: Parameters<RuntimeObserverPort["startRun"]>[0]): RuntimeRunObservation {
    this.record("run.started", fact);
    return {
      run: (operation) => operation(),
      userInput: (value) => this.record("user.input", value),
      startOperation: (value) => {
        this.record(`operation.${value.kind}.started`, value);
        return {
          ...NOOP_RUNTIME_OPERATION_OBSERVATION,
          complete: (terminal) => this.record(`operation.${value.kind}.completed`, terminal),
          fail: (terminal) => this.record(`operation.${value.kind}.failed`, terminal),
          cancel: (terminal) => this.record(`operation.${value.kind}.cancelled`, terminal),
        };
      },
      startTurn: (value) => {
        this.record("turn.started", value);
        return {
          ...NOOP_RUNTIME_TURN_OBSERVATION,
          startOperation: (operation) => {
            this.record(`operation.${operation.kind}.started`, operation);
            return {
              ...NOOP_RUNTIME_OPERATION_OBSERVATION,
              complete: (terminal) =>
                this.record(`operation.${operation.kind}.completed`, terminal),
              fail: (terminal) => this.record(`operation.${operation.kind}.failed`, terminal),
              cancel: (terminal) => this.record(`operation.${operation.kind}.cancelled`, terminal),
            };
          },
          startContext: (context) => {
            this.record("context.started", context);
            return {
              ...NOOP_RUNTIME_CONTEXT_OBSERVATION,
              progress: (progress) => this.record("context.progress", progress),
              prepared: (prepared) => this.record("context.prepared", prepared),
              complete: (terminal) => this.record("context.completed", terminal),
              fail: (terminal) => this.record("context.failed", terminal),
              cancel: (terminal) => this.record("context.cancelled", terminal),
            };
          },
          startModelCall: (model) => {
            this.record("model.started", model);
            return {
              ...NOOP_RUNTIME_MODEL_CALL_OBSERVATION,
              requestCaptured: (request) => this.record("model.request", request),
              output: (output) => this.record(`model.output.${output.kind}`, output),
              complete: (terminal) => this.record("model.completed", terminal),
              fail: (terminal) => this.record("model.failed", terminal),
              cancel: (terminal) => this.record("model.cancelled", terminal),
            };
          },
          startToolBatch: (batch) => {
            this.record("tool.batch.started", batch);
            return {
              ...NOOP_RUNTIME_TOOL_BATCH_OBSERVATION,
              startCall: (call) => {
                this.record("tool.call.started", call);
                return {
                  ...NOOP_RUNTIME_TOOL_CALL_OBSERVATION,
                  startPreflight: (preflight) => {
                    this.record("tool.preflight.started", preflight);
                    return NOOP_RUNTIME_PREFLIGHT_OBSERVATION;
                  },
                  startAuthorization: (authorization) => {
                    this.record("tool.authorization.started", authorization);
                    return NOOP_RUNTIME_AUTHORIZATION_OBSERVATION;
                  },
                  startExecution: (execution) => {
                    this.record("tool.execution.started", execution);
                    return NOOP_RUNTIME_EXECUTION_OBSERVATION;
                  },
                  result: (result) => this.record("tool.result", result),
                  complete: (terminal) => this.record("tool.call.completed", terminal),
                  deny: (terminal) => this.record("tool.call.denied", terminal),
                  fail: (terminal) => this.record("tool.call.failed", terminal),
                  cancel: (terminal) => this.record("tool.call.cancelled", terminal),
                };
              },
              complete: (terminal) => this.record("tool.batch.completed", terminal),
              fail: (terminal) => this.record("tool.batch.failed", terminal),
              cancel: (terminal) => this.record("tool.batch.cancelled", terminal),
            };
          },
          finalResponse: (value) => this.record("agent.final_response", value),
          complete: (terminal) => this.record("turn.completed", terminal),
          fail: (terminal) => this.record("turn.failed", terminal),
          cancel: (terminal) => this.record("turn.cancelled", terminal),
        };
      },
      complete: (value) => this.record("run.completed", value),
      fail: (value) => this.record("run.failed", value),
      cancel: (value) => this.record("run.cancelled", value),
    };
  }

  private record(operation: string, fact: unknown): void {
    this.records.push({ operation, fact: structuredClone(fact) });
  }
}
