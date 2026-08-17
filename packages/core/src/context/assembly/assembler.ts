import { cloneData } from "../../dataCopy";
import { assertTranscriptMessages, cloneTranscriptMessages } from "../../messages";
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
import { renderEnvironmentContext } from "../../environment";

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
    const { fixed, history } = input.result.envelope;
    const historyMessages = projectContextEntries(history.entries);
    const messages = fixed.environment
      ? [
          { role: "user" as const, content: renderEnvironmentContext(fixed.environment) },
          ...historyMessages,
        ]
      : historyMessages;
    const tools = fixed.tools.map(cloneModelToolSpec);
    const decisions = cloneData(input.result.decisions) as ContextDecision[];
    const sourceDigest = digestContextValue({
      messages: sourceMessages,
      environmentFingerprint: fixed.environment?.fingerprint,
    });
    const contextEntryDigest = digestContextValue(history.entries);
    const outputDigest = digestContextValue(messages);
    const systemPromptDigest = digestContextValue(fixed.systemPrompt);
    const toolsetDigest = digestContextValue(tools);
    const middleware = input.middleware.map((entry) => ({ ...entry }));
    const policyStages = input.result.stages.map((stage) => cloneData(stage));
    const artifactIds = history.entries
      .filter((entry) => entry.kind === "toolResultArtifact")
      .map((entry) => entry.artifact.id);
    const checkpointEntry = history.entries.find((entry) => entry.kind === "checkpoint");
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
      environmentFingerprint: fixed.environment?.fingerprint,
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
      ...(fixed.environment ? { environmentFingerprint: fixed.environment.fingerprint } : {}),
      estimatedInputTokens: input.result.estimate.totalInputTokens,
      contextWindow: fixed.model.contextWindow,
      modelMaxOutputTokens: fixed.model.modelMaxOutputTokens,
      requestedOutputTokens: fixed.model.requestedOutputTokens,
      usableInputBudget: input.result.estimate.usableInputBudget,
      usageRatio: input.result.estimate.usageRatio,
      artifactIds,
      checkpoint,
      decisions,
      createdAt: Date.now(),
    };

    return {
      snapshotId,
      systemPrompt: fixed.systemPrompt,
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
  assertTranscriptMessages(draft.messages, (message) => new Error(`Context middleware ${message}`));
  if (!Array.isArray(draft.tools)) throw new Error("Context middleware returned invalid tools");
  if (!draft.model || typeof draft.model !== "object") {
    throw new Error("Context middleware returned invalid model limits");
  }
  if (
    typeof draft.model.modelId !== "string" ||
    !Number.isFinite(draft.model.contextWindow) ||
    !Number.isFinite(draft.model.modelMaxOutputTokens) ||
    !Number.isFinite(draft.model.requestedOutputTokens) ||
    draft.model.requestedOutputTokens <= 0 ||
    draft.model.requestedOutputTokens > draft.model.modelMaxOutputTokens ||
    draft.model.requestedOutputTokens >= draft.model.contextWindow
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
