import type { TranscriptMessage } from "../../messages";
import type { ContextCheckpoint } from "./types";
import { digestContextValue } from "../digest";

export function resolveCompatibleCheckpoint(input: {
  readonly checkpoints: readonly ContextCheckpoint[];
  readonly sessionId: string;
  readonly messages: readonly TranscriptMessage[];
  readonly middlewareDigest: string;
  readonly policyDigest: string;
  readonly gateName: string;
  readonly gateVersion: number;
  readonly promptVersion: number;
}): ContextCheckpoint | undefined {
  return [...input.checkpoints]
    .reverse()
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .find((checkpoint) => {
      if (
        checkpoint.sessionId !== input.sessionId ||
        checkpoint.coveredMessageCount > input.messages.length ||
        checkpoint.sourceMiddlewareDigest !== input.middlewareDigest ||
        checkpoint.sourcePolicyDigest !== input.policyDigest ||
        checkpoint.gateName !== input.gateName ||
        checkpoint.gateVersion !== input.gateVersion ||
        checkpoint.promptVersion !== input.promptVersion ||
        checkpoint.summaryDigest !== digestContextValue(checkpoint.summary)
      ) {
        return false;
      }
      return (
        checkpoint.coveredTranscriptDigest ===
        digestContextValue(input.messages.slice(0, checkpoint.coveredMessageCount))
      );
    });
}
