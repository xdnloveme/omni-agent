import { digestContextValue } from "../digest";
import type { ContextArtifactStorePort } from "./contracts";
import type { ContextPolicyStagePort } from "../contracts/ports";
import type { ContextEntry, ContextPolicyStageResult } from "../contracts/types";
import { cloneContextFrame } from "../policy/types";
import { DEFAULT_CONTEXT_COMPRESSION_BUDGET } from "./budget";

const MINIMUM_TEXT_LENGTH = 500;
const PRESERVED_RECENT_RESULTS = 3;

export class ToolResultMicroStage implements ContextPolicyStagePort {
  readonly name = "tool_result_micro";
  readonly version = 1;

  constructor(private readonly artifacts: ContextArtifactStorePort) {}

  async apply(
    frame: Parameters<ContextPolicyStagePort["apply"]>[0],
    options: Parameters<ContextPolicyStagePort["apply"]>[1],
  ): Promise<ContextPolicyStageResult> {
    const output = cloneContextFrame(frame);
    if (options.estimate.usageRatio < DEFAULT_CONTEXT_COMPRESSION_BUDGET.microTriggerRatio) {
      return {
        frame: output,
        decisions: [{ type: "tool_result_micro_skipped", details: { reason: "below_threshold" } }],
      };
    }

    const candidates = output.entries.filter(isCandidate);
    const selected = new Set(candidates.slice(0, -PRESERVED_RECENT_RESULTS));
    const externalized: string[] = [];
    const entries: ContextEntry[] = [];
    for (const entry of output.entries) {
      if (!selected.has(entry as Extract<ContextEntry, { kind: "transcript" }>)) {
        entries.push(entry);
        continue;
      }
      const transcript = entry as Extract<ContextEntry, { kind: "transcript" }>;
      const message = transcript.message;
      if (message.role !== "toolResult") {
        entries.push(entry);
        continue;
      }
      const content = message.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("\n");
      const contentDigest = digestContextValue(message.content);
      const artifactId = digestContextValue({
        sessionId: options.sessionId,
        toolCallId: message.toolCallId,
        contentDigest,
      });
      const path = await this.artifacts.write({
        sessionId: options.sessionId,
        artifactId,
        content,
      });
      entries.push({
        kind: "toolResultArtifact",
        sourceIndex: transcript.sourceIndex,
        message,
        artifact: { id: artifactId, path, contentDigest, originalLength: content.length },
      });
      externalized.push(artifactId);
    }

    return {
      frame: { ...output, entries },
      decisions: [
        {
          type: "tool_result_micro",
          details: { externalizedCount: externalized.length, artifactIds: externalized },
        },
      ],
    };
  }
}

function isCandidate(entry: ContextEntry): entry is Extract<ContextEntry, { kind: "transcript" }> {
  if (entry.kind !== "transcript" || entry.message.role !== "toolResult") return false;
  if (entry.message.isError || entry.message.content.some((block) => block.type !== "text")) {
    return false;
  }
  return (
    entry.message.content.reduce(
      (total, block) => total + (block.type === "text" ? block.text.length : 0),
      0,
    ) > MINIMUM_TEXT_LENGTH
  );
}
