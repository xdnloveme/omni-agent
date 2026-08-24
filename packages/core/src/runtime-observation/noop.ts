import type {
  RuntimeAccessObservation,
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

const scope: RuntimeObservationScope = {
  run: <T>(operation: () => T) => operation(),
};

export const NOOP_RUNTIME_OPERATION_OBSERVATION: RuntimeOperationObservation = {
  ...scope,
  complete() {},
  fail() {},
  cancel() {},
};

export const NOOP_RUNTIME_CONTEXT_OBSERVATION: RuntimeContextObservation = {
  ...NOOP_RUNTIME_OPERATION_OBSERVATION,
  progress() {},
  prepared() {},
};

export const NOOP_RUNTIME_MODEL_CALL_OBSERVATION: RuntimeModelCallObservation = {
  ...scope,
  requestCaptured() {},
  output() {},
  complete() {},
  fail() {},
  cancel() {},
};

export const NOOP_RUNTIME_PREFLIGHT_OBSERVATION: RuntimePreflightObservation = {
  ...NOOP_RUNTIME_OPERATION_OBSERVATION,
};

export const NOOP_RUNTIME_ACCESS_OBSERVATION: RuntimeAccessObservation = {
  ...scope,
  complete() {},
  deny() {},
  fail() {},
  cancel() {},
};

export const NOOP_RUNTIME_EXECUTION_OBSERVATION: RuntimeExecutionObservation = {
  ...scope,
  complete() {},
  timeout() {},
  fail() {},
  cancel() {},
};

export const NOOP_RUNTIME_TOOL_CALL_OBSERVATION: RuntimeToolCallObservation = {
  ...scope,
  startPreflight: () => NOOP_RUNTIME_PREFLIGHT_OBSERVATION,
  startAccess: () => NOOP_RUNTIME_ACCESS_OBSERVATION,
  startExecution: () => NOOP_RUNTIME_EXECUTION_OBSERVATION,
  result() {},
  complete() {},
  deny() {},
  fail() {},
  cancel() {},
};

export const NOOP_RUNTIME_TOOL_BATCH_OBSERVATION: RuntimeToolBatchObservation = {
  ...scope,
  startCall: () => NOOP_RUNTIME_TOOL_CALL_OBSERVATION,
  complete() {},
  fail() {},
  cancel() {},
};

export const NOOP_RUNTIME_TURN_OBSERVATION: RuntimeTurnObservation = {
  ...scope,
  startOperation: () => NOOP_RUNTIME_OPERATION_OBSERVATION,
  startContext: () => NOOP_RUNTIME_CONTEXT_OBSERVATION,
  startModelCall: () => NOOP_RUNTIME_MODEL_CALL_OBSERVATION,
  startToolBatch: () => NOOP_RUNTIME_TOOL_BATCH_OBSERVATION,
  finalResponse() {},
  complete() {},
  fail() {},
  cancel() {},
};

export const NOOP_RUNTIME_RUN_OBSERVATION: RuntimeRunObservation = {
  ...scope,
  userInput() {},
  startOperation: () => NOOP_RUNTIME_OPERATION_OBSERVATION,
  startTurn: () => NOOP_RUNTIME_TURN_OBSERVATION,
  complete() {},
  fail() {},
  cancel() {},
};

export const NOOP_RUNTIME_OBSERVER: RuntimeObserverPort = {
  startRun: () => NOOP_RUNTIME_RUN_OBSERVATION,
};
