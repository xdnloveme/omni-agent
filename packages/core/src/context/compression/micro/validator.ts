import { assertPolicyStageResult } from "../../policy/validator";
import type { MicroProjectionResult, MicroProjectionStrategyPort } from "./contracts";

export class InvalidMicroProjectionResultError extends Error {
  constructor(strategy: string, message: string) {
    super(`Invalid Micro Projection result from ${strategy}: ${message}`);
    this.name = "InvalidMicroProjectionResultError";
  }
}

export function assertMicroProjectionResult(
  result: MicroProjectionResult,
  strategy: MicroProjectionStrategyPort,
  phase: "replay" | "advance",
): void {
  assertPolicyStageResult({ frame: result?.frame, decisions: [] }, strategy.name);
  if (!result.state || typeof result.state !== "object") invalid(strategy, "state is required");
  const expected = strategy.createState();
  if (
    result.state.strategyName !== strategy.name ||
    result.state.strategyVersion !== strategy.version ||
    result.state.configurationDigest !== expected.configurationDigest ||
    !Array.isArray(result.state.records)
  ) {
    invalid(strategy, "state identity or configuration is inconsistent");
  }
  if (typeof result.changed !== "boolean" || !Array.isArray(result.artifacts)) {
    invalid(strategy, "changed and artifacts are required");
  }
  if (phase === "replay" && (result.changed || result.artifacts.length > 0)) {
    invalid(strategy, "replay must be read-only");
  }
  for (const record of result.state.records) {
    if (
      !record ||
      record.kind !== strategy.key ||
      !record.sourceId ||
      !Number.isInteger(record.sourceIndex) ||
      record.sourceIndex < 0 ||
      !record.sourceDigest ||
      !record.projectionDigest
    ) {
      invalid(strategy, "projection record is invalid");
    }
  }
  for (const artifact of result.artifacts) {
    if (!artifact?.artifactId || typeof artifact.content !== "string" || !artifact.contentDigest) {
      invalid(strategy, "pending artifact is invalid");
    }
  }
}

function invalid(strategy: MicroProjectionStrategyPort, message: string): never {
  throw new InvalidMicroProjectionResultError(strategy.name, message);
}
