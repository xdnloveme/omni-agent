import { cloneData } from "../../dataCopy";
import { cloneTranscriptMessages } from "../../messages";
import type {
  ContextComponentManifest,
  ContextDecision,
  ContextDraft,
  ContextPolicyResult,
  ModelContextSnapshotManifest,
  PreparedModelContext,
} from "../contracts/types";
import { cloneModelToolSpec } from "./draft";
import { projectContextEntries } from "./entryProjection";
import { digestContextValue } from "../digest";

export interface ContextAssemblyInput {
  readonly identity: {
    readonly agentId: string;
    readonly sessionId: string;
    readonly sessionRevision: number;
    readonly modelCallId: string;
  };
  readonly transformedDraft: ContextDraft;
  readonly result: ContextPolicyResult;
  readonly middleware: readonly ContextComponentManifest[];
}

export class ContextAssembler {
  assemble(input: ContextAssemblyInput): PreparedModelContext {
    const sourceMessages = cloneTranscriptMessages(input.transformedDraft.messages);
    const messages = projectContextEntries(input.result.frame.entries);
    const tools = input.result.frame.tools.map(cloneModelToolSpec);
    const decisions = cloneData(input.result.decisions) as ContextDecision[];
    const sourceDigest = digestContextValue(sourceMessages);
    const contextEntryDigest = digestContextValue(input.result.frame.entries);
    const outputDigest = digestContextValue(messages);
    const systemPromptDigest = digestContextValue(input.result.frame.systemPrompt);
    const toolsetDigest = digestContextValue(tools);
    const middleware = input.middleware.map((entry) => ({ ...entry }));
    const policyStages = input.result.stages.map((stage) => cloneData(stage));
    const artifactIds = input.result.frame.entries
      .filter((entry) => entry.kind === "toolResultArtifact")
      .map((entry) => entry.artifact.id);
    const checkpointEntry = input.result.frame.entries.find((entry) => entry.kind === "checkpoint");
    const checkpointDecision = input.result.decisions.find((decision) =>
      ["checkpoint_reused", "checkpoint_created", "checkpoint_extended"].includes(decision.type),
    );
    const checkpoint =
      checkpointEntry?.kind === "checkpoint" && checkpointDecision
        ? {
            action:
              checkpointDecision.type === "checkpoint_reused"
                ? ("reuse" as const)
                : checkpointDecision.type === "checkpoint_created"
                  ? ("create" as const)
                  : ("extend" as const),
            checkpointId: checkpointEntry.checkpointId,
            parentId: checkpointEntry.parentId,
            coveredMessageCount: checkpointEntry.coveredMessageCount,
            summaryDigest: digestContextValue(checkpointEntry.summary),
            summaryModelCallId: checkpointEntry.summaryModelCallId,
          }
        : undefined;
    const snapshotId = digestContextValue({
      ...input.identity,
      policyStages,
      middleware,
      sourceDigest,
      contextEntryDigest,
      outputDigest,
      systemPromptDigest,
      toolsetDigest,
      decisions,
      artifactIds,
      checkpoint,
    });
    const manifest: ModelContextSnapshotManifest = {
      snapshotId,
      ...input.identity,
      policyStages,
      middleware,
      sourceMessageCount: sourceMessages.length,
      outputMessageCount: messages.length,
      sourceDigest,
      contextEntryDigest,
      outputDigest,
      systemPromptDigest,
      toolsetDigest,
      estimatedInputTokens: input.result.estimate.totalInputTokens,
      usableInputBudget: input.result.estimate.usableInputBudget,
      usageRatio: input.result.estimate.usageRatio,
      artifactIds,
      checkpoint,
      decisions,
      createdAt: Date.now(),
    };

    return {
      snapshotId,
      systemPrompt: input.result.frame.systemPrompt,
      messages,
      tools,
      manifest,
    };
  }
}

export function assertContextDraft(value: unknown): asserts value is ContextDraft {
  if (!value || typeof value !== "object") throw new Error("Context middleware returned no draft");
  const draft = value as Partial<ContextDraft>;
  if (typeof draft.systemPrompt !== "string") {
    throw new Error("Context middleware returned an invalid system prompt");
  }
  if (!Array.isArray(draft.messages)) {
    throw new Error("Context middleware returned invalid messages");
  }
  assertMessages(draft.messages, (message) => new Error(`Context middleware ${message}`));
  if (!Array.isArray(draft.tools)) throw new Error("Context middleware returned invalid tools");
  if (!draft.model || typeof draft.model !== "object") {
    throw new Error("Context middleware returned invalid model limits");
  }
  if (
    typeof draft.model.modelId !== "string" ||
    !Number.isFinite(draft.model.contextWindow) ||
    !Number.isFinite(draft.model.maxOutputTokens)
  ) {
    throw new Error("Context middleware returned invalid model limits");
  }
  for (const tool of draft.tools) {
    if (
      !tool ||
      typeof tool !== "object" ||
      typeof tool.name !== "string" ||
      typeof tool.description !== "string" ||
      !tool.schema ||
      typeof tool.schema !== "object" ||
      Array.isArray(tool.schema) ||
      (tool.strict !== undefined && typeof tool.strict !== "boolean")
    ) {
      throw new Error("Context middleware returned an invalid model tool");
    }
  }
}

function assertMessages(messages: readonly unknown[], error: (message: string) => Error): void {
  for (const message of messages) {
    if (!message || typeof message !== "object") throw error("returned an invalid message");
    const candidate = message as Record<string, unknown>;
    if (!Number.isFinite(candidate.timestamp)) throw error("returned a message without timestamp");
    if (candidate.role === "user") {
      if (typeof candidate.content !== "string" && !Array.isArray(candidate.content)) {
        throw error("returned an invalid user message");
      }
      continue;
    }
    if (candidate.role === "assistant") {
      if (
        !Array.isArray(candidate.content) ||
        typeof candidate.api !== "string" ||
        typeof candidate.provider !== "string" ||
        typeof candidate.model !== "string" ||
        typeof candidate.stopReason !== "string" ||
        !candidate.usage ||
        typeof candidate.usage !== "object"
      ) {
        throw error("returned an invalid assistant message");
      }
      continue;
    }
    if (candidate.role === "toolResult") {
      if (
        typeof candidate.toolCallId !== "string" ||
        typeof candidate.toolName !== "string" ||
        !Array.isArray(candidate.content) ||
        typeof candidate.isError !== "boolean"
      ) {
        throw error("returned an invalid tool-result message");
      }
      continue;
    }
    throw error("returned a message with an unknown role");
  }
}
