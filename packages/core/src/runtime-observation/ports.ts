import type {
  RuntimeAuthorizationCompletedFact,
  RuntimeAuthorizationDeniedFact,
  RuntimeAuthorizationStartedFact,
  RuntimeCancelledFact,
  RuntimeContextPreparedFact,
  RuntimeContextProgressFact,
  RuntimeContextStartedFact,
  RuntimeExecutionCompletedFact,
  RuntimeExecutionStartedFact,
  RuntimeExecutionTimedOutFact,
  RuntimeFailedFact,
  RuntimeFinalResponseFact,
  RuntimeModelCallCompletedFact,
  RuntimeModelCallFailedFact,
  RuntimeModelCallStartedFact,
  RuntimeModelOutputFact,
  RuntimeModelRequestCapturedFact,
  RuntimeOperationCompletedFact,
  RuntimeOperationStartedFact,
  RuntimePreflightCompletedFact,
  RuntimePreflightStartedFact,
  RuntimeRunCancelledFact,
  RuntimeRunCompletedFact,
  RuntimeRunFailedFact,
  RuntimeRunStartedFact,
  RuntimeToolBatchCompletedFact,
  RuntimeToolBatchStartedFact,
  RuntimeToolCallCompletedFact,
  RuntimeToolCallDeniedFact,
  RuntimeToolCallResultFact,
  RuntimeToolCallStartedFact,
  RuntimeTurnCompletedFact,
  RuntimeTurnFailedFact,
  RuntimeTurnStartedFact,
  RuntimeUserInputFact,
} from "./facts";

export interface RuntimeObservationScope {
  run<T>(operation: () => T): T;
}

export interface RuntimeObserverPort {
  startRun(fact: RuntimeRunStartedFact): RuntimeRunObservation;
}

export interface RuntimeRunObservation extends RuntimeObservationScope {
  userInput(fact: RuntimeUserInputFact): void;
  startOperation(fact: RuntimeOperationStartedFact): RuntimeOperationObservation;
  startTurn(fact: RuntimeTurnStartedFact): RuntimeTurnObservation;
  complete(fact: RuntimeRunCompletedFact): void;
  fail(fact: RuntimeRunFailedFact): void;
  cancel(fact: RuntimeRunCancelledFact): void;
}

export interface RuntimeOperationObservation extends RuntimeObservationScope {
  complete(fact: RuntimeOperationCompletedFact): void;
  fail(fact: RuntimeFailedFact): void;
  cancel(fact: RuntimeCancelledFact): void;
}

export interface RuntimeTurnObservation extends RuntimeObservationScope {
  startOperation(fact: RuntimeOperationStartedFact): RuntimeOperationObservation;
  startContext(fact: RuntimeContextStartedFact): RuntimeContextObservation;
  startModelCall(fact: RuntimeModelCallStartedFact): RuntimeModelCallObservation;
  startToolBatch(fact: RuntimeToolBatchStartedFact): RuntimeToolBatchObservation;
  finalResponse(fact: RuntimeFinalResponseFact): void;
  complete(fact: RuntimeTurnCompletedFact): void;
  fail(fact: RuntimeTurnFailedFact): void;
  cancel(fact: RuntimeCancelledFact): void;
}

export interface RuntimeContextObservation extends RuntimeObservationScope {
  progress(fact: RuntimeContextProgressFact): void;
  prepared(fact: RuntimeContextPreparedFact): void;
  complete(fact: RuntimeOperationCompletedFact): void;
  fail(fact: RuntimeFailedFact): void;
  cancel(fact: RuntimeCancelledFact): void;
}

export interface RuntimeModelCallObservation extends RuntimeObservationScope {
  requestCaptured(fact: RuntimeModelRequestCapturedFact): void;
  output(fact: RuntimeModelOutputFact): void;
  complete(fact: RuntimeModelCallCompletedFact): void;
  fail(fact: RuntimeModelCallFailedFact): void;
  cancel(fact: RuntimeCancelledFact): void;
}

export interface RuntimeToolBatchObservation extends RuntimeObservationScope {
  startCall(fact: RuntimeToolCallStartedFact): RuntimeToolCallObservation;
  complete(fact: RuntimeToolBatchCompletedFact): void;
  fail(fact: RuntimeFailedFact): void;
  cancel(fact: RuntimeCancelledFact): void;
}

export interface RuntimeToolCallObservation extends RuntimeObservationScope {
  startPreflight(fact: RuntimePreflightStartedFact): RuntimePreflightObservation;
  startAuthorization(fact: RuntimeAuthorizationStartedFact): RuntimeAuthorizationObservation;
  startExecution(fact: RuntimeExecutionStartedFact): RuntimeExecutionObservation;
  result(fact: RuntimeToolCallResultFact): void;
  complete(fact: RuntimeToolCallCompletedFact): void;
  deny(fact: RuntimeToolCallDeniedFact): void;
  fail(fact: RuntimeFailedFact): void;
  cancel(fact: RuntimeCancelledFact): void;
}

export interface RuntimePreflightObservation extends RuntimeObservationScope {
  complete(fact: RuntimePreflightCompletedFact): void;
  fail(fact: RuntimeFailedFact): void;
  cancel(fact: RuntimeCancelledFact): void;
}

export interface RuntimeAuthorizationObservation extends RuntimeObservationScope {
  complete(fact: RuntimeAuthorizationCompletedFact): void;
  deny(fact: RuntimeAuthorizationDeniedFact): void;
  fail(fact: RuntimeFailedFact): void;
  cancel(fact: RuntimeCancelledFact): void;
}

export interface RuntimeExecutionObservation extends RuntimeObservationScope {
  complete(fact: RuntimeExecutionCompletedFact): void;
  timeout(fact: RuntimeExecutionTimedOutFact): void;
  fail(fact: RuntimeFailedFact): void;
  cancel(fact: RuntimeCancelledFact): void;
}
