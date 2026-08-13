import { createHash } from "node:crypto";
import { cloneData } from "../../dataCopy";
import { cloneTranscriptMessages } from "../../messages";
import type {
  ContextComponentManifest,
  ContextDecision,
  ContextDraft,
  ContextStrategyResult,
  ModelContextSnapshotManifest,
  PreparedModelContext,
} from "../contracts/types";
import { cloneModelToolSpec } from "./draft";
import { toContextMessages } from "./messageProjection";

export class InvalidContextStrategyResultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidContextStrategyResultError";
  }
}

export interface ContextAssemblyInput {
  readonly identity: {
    readonly agentId: string;
    readonly sessionId: string;
    readonly sessionRevision: number;
    readonly modelCallId: string;
  };
  readonly transformedDraft: ContextDraft;
  readonly result: ContextStrategyResult;
  readonly strategy: ContextComponentManifest;
  readonly middleware: readonly ContextComponentManifest[];
}

export class ContextAssembler {
  assemble(input: ContextAssemblyInput): PreparedModelContext {
    assertStrategyResult(input.result);

    const sourceMessages = cloneTranscriptMessages(input.transformedDraft.messages);
    const messages = toContextMessages(input.result.messages);
    const tools = input.transformedDraft.tools.map(cloneModelToolSpec);
    const decisions = cloneData(input.result.decisions) as ContextDecision[];
    const sourceDigest = digest(sourceMessages);
    const outputDigest = digest(messages);
    const systemPromptDigest = digest(input.transformedDraft.systemPrompt);
    const toolsetDigest = digest(tools);
    const strategy = { ...input.strategy };
    const middleware = input.middleware.map((entry) => ({ ...entry }));
    const snapshotId = digest({
      ...input.identity,
      strategy,
      middleware,
      sourceDigest,
      outputDigest,
      systemPromptDigest,
      toolsetDigest,
      decisions,
    });
    const manifest: ModelContextSnapshotManifest = {
      snapshotId,
      ...input.identity,
      strategy,
      middleware,
      sourceMessageCount: sourceMessages.length,
      outputMessageCount: messages.length,
      sourceDigest,
      outputDigest,
      systemPromptDigest,
      toolsetDigest,
      decisions,
      createdAt: Date.now(),
    };

    return {
      snapshotId,
      systemPrompt: input.transformedDraft.systemPrompt,
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

function assertStrategyResult(value: unknown): asserts value is ContextStrategyResult {
  if (!value || typeof value !== "object") {
    throw new InvalidContextStrategyResultError("Context strategy returned no result");
  }
  const result = value as Partial<ContextStrategyResult>;
  if (!Array.isArray(result.messages)) {
    throw new InvalidContextStrategyResultError("Context strategy returned invalid messages");
  }
  assertMessages(
    result.messages,
    (message) => new InvalidContextStrategyResultError(`Context strategy ${message}`),
  );
  if (!Array.isArray(result.decisions)) {
    throw new InvalidContextStrategyResultError("Context strategy returned invalid decisions");
  }
  for (const decision of result.decisions) {
    if (
      !decision ||
      typeof decision !== "object" ||
      typeof decision.type !== "string" ||
      !decision.type.trim() ||
      (decision.details !== undefined &&
        (!decision.details ||
          typeof decision.details !== "object" ||
          Array.isArray(decision.details)))
    ) {
      throw new InvalidContextStrategyResultError("Context strategy returned an invalid decision");
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

function digest(value: unknown): string {
  return createHash("sha256").update(stableSerialize(value)).digest("hex");
}

function stableSerialize(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === undefined) return { $undefined: true };
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}
