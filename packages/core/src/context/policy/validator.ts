import type { ContextFinalGatePort, ContextPolicyStagePort } from "../contracts/ports";
import type {
  ContextFrame,
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
  assertFrame(result.frame, "Context policy");
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
  assertFrame(result.frame, `Context policy stage ${name}`);
  assertDecisions(result.decisions, `Context policy stage ${name}`);
}

function assertFrame(value: unknown, label: string): asserts value is ContextFrame {
  if (!value || typeof value !== "object") {
    throw new InvalidContextPolicyResultError(`${label} returned no frame`);
  }
  const frame = value as Partial<ContextFrame>;
  if (!Array.isArray(frame.entries) || !Array.isArray(frame.tools)) {
    throw new InvalidContextPolicyResultError(`${label} returned an invalid frame`);
  }
  if (
    typeof frame.systemPrompt !== "string" ||
    !frame.model ||
    typeof frame.model !== "object" ||
    typeof frame.model.modelId !== "string" ||
    !Number.isFinite(frame.model.contextWindow) ||
    !Number.isFinite(frame.model.modelMaxOutputTokens) ||
    !Number.isFinite(frame.model.requestedOutputTokens) ||
    frame.model.requestedOutputTokens <= 0 ||
    frame.model.requestedOutputTokens > frame.model.modelMaxOutputTokens ||
    frame.model.requestedOutputTokens >= frame.model.contextWindow
  ) {
    throw new InvalidContextPolicyResultError(`${label} returned invalid model limits`);
  }
  for (const entry of frame.entries) assertEntry(entry, label);
  for (const tool of frame.tools) {
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
}

function assertEntry(entry: ContextFrame["entries"][number], label: string): void {
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
