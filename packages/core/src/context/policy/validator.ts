import type { ContextFinalGatePort, ContextPolicyStagePort } from "../contracts/ports";
import type {
  ContextEnvelope,
  ContextHistoryFrame,
  ContextPolicyResult,
  ContextPolicyStageResult,
} from "../contracts/types";

export class InvalidContextPolicyResultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidContextPolicyResultError";
  }
}

export function assertContextPolicyResult(value: unknown): asserts value is ContextPolicyResult {
  if (!value || typeof value !== "object") {
    throw new InvalidContextPolicyResultError("Context policy returned no result");
  }
  const result = value as Partial<ContextPolicyResult>;
  assertEnvelope(result.envelope, "Context policy");
  assertDecisions(result.decisions, "Context policy");
  if (!Array.isArray(result.stages) || !result.estimate || typeof result.estimate !== "object") {
    throw new InvalidContextPolicyResultError("Context policy returned invalid trace data");
  }
}

export function assertPolicyComponent(
  component: ContextPolicyStagePort | ContextFinalGatePort,
): void {
  if (!component || typeof component !== "object") throw new Error("Invalid context policy stage");
  if (typeof component.name !== "string" || !component.name.trim()) {
    throw new Error("Context policy stage name is required");
  }
  if (!Number.isInteger(component.version) || component.version < 1) {
    throw new Error(`Context policy stage version must be a positive integer: ${component.name}`);
  }
  if (component.configurationDigest !== undefined) {
    if (typeof component.configurationDigest !== "function") {
      throw new Error(`Context policy stage configuration digest is invalid: ${component.name}`);
    }
    const digest = component.configurationDigest();
    if (typeof digest !== "string" || !digest) {
      throw new Error(`Context policy stage configuration digest is invalid: ${component.name}`);
    }
  }
  if (typeof component.apply !== "function") {
    throw new Error(`Context policy stage apply is required: ${component.name}`);
  }
}

export function assertPolicyStageResult(
  result: ContextPolicyStageResult,
  name: string,
): asserts result is ContextPolicyStageResult {
  if (!result || typeof result !== "object") {
    throw new InvalidContextPolicyResultError(`Context policy stage returned no frame: ${name}`);
  }
  assertHistoryFrame(result.frame, `Context policy stage ${name}`);
  assertDecisions(result.decisions, `Context policy stage ${name}`);
}

function assertEnvelope(value: unknown, label: string): asserts value is ContextEnvelope {
  if (!value || typeof value !== "object") {
    throw new InvalidContextPolicyResultError(`${label} returned no envelope`);
  }
  const envelope = value as Partial<ContextEnvelope>;
  if (!envelope.fixed || typeof envelope.fixed !== "object") {
    throw new InvalidContextPolicyResultError(`${label} returned invalid fixed context`);
  }
  const fixed = envelope.fixed;
  if (
    typeof fixed.systemPrompt !== "string" ||
    !Array.isArray(fixed.tools) ||
    !fixed.model ||
    typeof fixed.model !== "object" ||
    typeof fixed.model.modelId !== "string" ||
    !Number.isFinite(fixed.model.contextWindow) ||
    !Number.isFinite(fixed.model.modelMaxOutputTokens) ||
    !Number.isFinite(fixed.model.requestedOutputTokens) ||
    fixed.model.requestedOutputTokens <= 0 ||
    fixed.model.requestedOutputTokens > fixed.model.modelMaxOutputTokens ||
    fixed.model.requestedOutputTokens >= fixed.model.contextWindow
  ) {
    throw new InvalidContextPolicyResultError(`${label} returned invalid model limits`);
  }
  for (const tool of fixed.tools) {
    if (
      !tool ||
      typeof tool !== "object" ||
      typeof tool.name !== "string" ||
      typeof tool.description !== "string" ||
      !tool.schema ||
      typeof tool.schema !== "object"
    ) {
      throw new InvalidContextPolicyResultError(`${label} returned an invalid model tool`);
    }
  }
  assertHistoryFrame(envelope.history, label);
}

function assertHistoryFrame(value: unknown, label: string): asserts value is ContextHistoryFrame {
  if (!value || typeof value !== "object") {
    throw new InvalidContextPolicyResultError(`${label} returned no history frame`);
  }
  const frame = value as Partial<ContextHistoryFrame>;
  if (!Array.isArray(frame.entries)) {
    throw new InvalidContextPolicyResultError(`${label} returned an invalid history frame`);
  }
  for (const entry of frame.entries) assertEntry(entry, label);
}

function assertEntry(entry: ContextHistoryFrame["entries"][number], label: string): void {
  if (
    !entry ||
    typeof entry !== "object" ||
    !["transcript", "checkpoint", "toolResultArtifact"].includes(entry.kind)
  ) {
    throw new InvalidContextPolicyResultError(`${label} returned an invalid entry`);
  }
  if (entry.kind !== "checkpoint" && !Number.isInteger(entry.sourceIndex)) {
    throw new InvalidContextPolicyResultError(`${label} returned an invalid source index`);
  }
  if (
    entry.kind !== "checkpoint" &&
    (!entry.message || !["user", "assistant", "toolResult"].includes(entry.message.role))
  ) {
    throw new InvalidContextPolicyResultError(`${label} returned an invalid transcript entry`);
  }
  if (
    entry.kind === "toolResultArtifact" &&
    (!entry.artifact ||
      typeof entry.artifact.id !== "string" ||
      typeof entry.artifact.path !== "string" ||
      typeof entry.artifact.contentDigest !== "string" ||
      !Number.isFinite(entry.artifact.originalLength) ||
      typeof entry.artifact.recoveryInstruction !== "string")
  ) {
    throw new InvalidContextPolicyResultError(`${label} returned an invalid artifact entry`);
  }
  if (
    entry.kind === "checkpoint" &&
    (typeof entry.checkpointId !== "string" ||
      !Number.isInteger(entry.coveredMessageCount) ||
      typeof entry.summary !== "string" ||
      typeof entry.summaryModelCallId !== "string")
  ) {
    throw new InvalidContextPolicyResultError(`${label} returned an invalid checkpoint entry`);
  }
}

function assertDecisions(value: unknown, label: string): void {
  if (!Array.isArray(value)) {
    throw new InvalidContextPolicyResultError(`${label} returned invalid decisions`);
  }
  for (const decision of value) {
    if (
      !decision ||
      typeof decision !== "object" ||
      typeof decision.type !== "string" ||
      !decision.type.trim()
    ) {
      throw new InvalidContextPolicyResultError(`${label} returned an invalid decision`);
    }
  }
}
