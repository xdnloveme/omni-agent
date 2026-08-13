import { throwIfAborted } from "../../../../execution";
import type { ToolResultTranscriptMessage } from "../../../../messages";
import { digestContextValue } from "../../../digest";
import { cloneContextFrame } from "../../../policy/types";
import type {
  ContextArtifactRecoveryCapability,
  ContextEntry,
  ContextFrame,
} from "../../../contracts/types";
import type {
  ContextProjectionStorePort,
  MicroProjectionOptions,
  MicroProjectionRecord,
  MicroProjectionResult,
  MicroProjectionStrategyPort,
  MicroStrategyProjectionState,
  PendingContextArtifact,
} from "../contracts";
import {
  createStrategyState,
  indexProjectionRecords,
  projectionRecordKey,
  unchangedProjection,
  validStrategyRecords,
} from "../strategyState";

const MINIMUM_TEXT_LENGTH = 500;
const PRESERVED_RECENT_RESULTS = 3;

export class ArtifactProjectionStrategy implements MicroProjectionStrategyPort {
  readonly key = "artifact" as const;
  readonly name = "artifact_projection";
  readonly compressionKind = "artifact_projection" as const;
  readonly version = 1;
  private readonly configurationDigest: string;

  constructor(
    private readonly projections: ContextProjectionStorePort,
    private readonly recovery: ContextArtifactRecoveryCapability | undefined,
    private readonly excludedToolNames: readonly string[] = [],
  ) {
    this.configurationDigest = digestContextValue({
      recovery,
      excludedToolNames: [...excludedToolNames].sort(),
      minimumTextLength: MINIMUM_TEXT_LENGTH,
      preservedRecentResults: PRESERVED_RECENT_RESULTS,
    });
  }

  createState(): MicroStrategyProjectionState {
    return createStrategyState(this, this.configurationDigest);
  }

  canAdvance(
    frame: Readonly<ContextFrame>,
    state: Readonly<MicroStrategyProjectionState>,
  ): boolean {
    if (!this.recovery) return false;
    const existing = new Set(validStrategyRecords(state, this).map((record) => record.sourceId));
    return this.selectedCandidates(frame).some(
      (entry) => !existing.has(sourceId(entry.message as ToolResultTranscriptMessage)),
    );
  }

  async replay(
    frame: Readonly<ContextFrame>,
    state: Readonly<MicroStrategyProjectionState>,
    options: Readonly<MicroProjectionOptions>,
  ): Promise<MicroProjectionResult> {
    const records = validStrategyRecords(state, this);
    if (!this.recovery || records.length === 0)
      return unchangedProjection(frame, this.createState());
    const recordIndex = indexProjectionRecords(records);
    const output = cloneContextFrame(frame);
    let replayed = 0;
    const retained: MicroProjectionRecord[] = [];
    const entries: ContextEntry[] = [];
    for (const entry of output.entries) {
      throwIfAborted(options.signal);
      if (entry.kind !== "transcript" || entry.message.role !== "toolResult") {
        entries.push(entry);
        continue;
      }
      const record = recordIndex.get(
        projectionRecordKey({
          sourceId: sourceId(entry.message as ToolResultTranscriptMessage),
          sourceIndex: entry.sourceIndex,
          sourceDigest: digestContextValue(entry.message),
        }),
      );
      const artifactId = stringData(record, "artifactId");
      const contentDigest = stringData(record, "contentDigest");
      const originalLength = optionalNumberData(record, "originalLength");
      if (
        !record ||
        !artifactId ||
        !contentDigest ||
        originalLength === undefined ||
        !(await this.projections.artifactMatches(options.sessionId, artifactId, contentDigest))
      ) {
        entries.push(entry);
        continue;
      }
      const path = this.projections.artifactPath(options.sessionId, artifactId);
      const projected = toArtifactEntry(entry, record, path, this.recovery.instruction);
      if (digestContextValue(projected) !== record.projectionDigest) {
        entries.push(entry);
        continue;
      }
      entries.push(projected);
      retained.push(record);
      replayed++;
    }
    return {
      frame: { ...output, entries },
      state: { ...this.createState(), records: retained },
      changed: false,
      artifacts: [],
      ...(replayed > 0 ? { details: { replayedCount: replayed } } : {}),
    };
  }

  async advance(
    frame: Readonly<ContextFrame>,
    state: Readonly<MicroStrategyProjectionState>,
    options: Readonly<MicroProjectionOptions>,
  ): Promise<MicroProjectionResult> {
    if (!this.recovery) return unchangedProjection(frame, this.createState());
    const records = [...validStrategyRecords(state, this)];
    const existing = new Set(records.map((record) => record.sourceId));
    const selectedIds = new Set(
      this.selectedCandidates(frame)
        .map((entry) => entry.message as ToolResultTranscriptMessage)
        .filter((message) => !existing.has(sourceId(message)))
        .map(sourceId),
    );
    if (selectedIds.size === 0)
      return unchangedProjection(
        frame,
        createStrategyState(this, this.configurationDigest, records),
      );
    const output = cloneContextFrame(frame);
    const entries: ContextEntry[] = [];
    const artifacts: PendingContextArtifact[] = [];
    for (const entry of output.entries) {
      throwIfAborted(options.signal);
      if (
        entry.kind !== "transcript" ||
        entry.message.role !== "toolResult" ||
        !selectedIds.has(sourceId(entry.message))
      ) {
        entries.push(entry);
        continue;
      }
      const transcript = entry as Extract<ContextEntry, { kind: "transcript" }>;
      const message = transcript.message as ToolResultTranscriptMessage;
      const content = textOf(message);
      const contentDigest = digestContextValue(content);
      const artifactId = digestContextValue({
        sessionId: options.sessionId,
        toolCallId: message.toolCallId,
        contentDigest,
      });
      const path = this.projections.artifactPath(options.sessionId, artifactId);
      const artifact = {
        id: artifactId,
        path,
        contentDigest,
        originalLength: content.length,
        recoveryInstruction: this.recovery.instruction,
      };
      const projected: ContextEntry = {
        kind: "toolResultArtifact",
        sourceIndex: transcript.sourceIndex,
        message,
        artifact,
      };
      const record: MicroProjectionRecord = {
        kind: "artifact",
        sourceId: sourceId(message),
        sourceIndex: transcript.sourceIndex,
        sourceDigest: digestContextValue(message),
        projectionDigest: digestContextValue(projected),
        data: {
          artifactId,
          contentDigest,
          originalLength: content.length,
        },
      };
      records.push(record);
      artifacts.push({ artifactId, content, contentDigest });
      entries.push(projected);
    }
    return {
      frame: { ...output, entries },
      state: createStrategyState(this, this.configurationDigest, records),
      changed: true,
      affectedCount: selectedIds.size,
      artifacts,
      details: {
        advancedCount: selectedIds.size,
        artifactIds: artifacts.map((item) => item.artifactId),
      },
    };
  }

  private selectedCandidates(
    frame: Readonly<ContextFrame>,
  ): Extract<ContextEntry, { kind: "transcript" }>[] {
    const candidates = frame.entries.filter(
      (entry): entry is Extract<ContextEntry, { kind: "transcript" }> =>
        entry.kind === "transcript" &&
        entry.message.role === "toolResult" &&
        !this.excludedToolNames.includes(entry.message.toolName) &&
        isEligible(entry.message),
    );
    return candidates.slice(0, -PRESERVED_RECENT_RESULTS);
  }
}

function isEligible(message: ToolResultTranscriptMessage): boolean {
  return (
    !message.isError &&
    message.content.every((block) => block.type === "text") &&
    textOf(message).length > MINIMUM_TEXT_LENGTH
  );
}

function textOf(message: ToolResultTranscriptMessage): string {
  return message.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
}

function sourceId(message: ToolResultTranscriptMessage): string {
  return `toolResult:${message.toolCallId}`;
}

function stringData(record: MicroProjectionRecord | undefined, key: string): string | undefined {
  const value = record?.data?.[key];
  return typeof value === "string" ? value : undefined;
}

function optionalNumberData(
  record: MicroProjectionRecord | undefined,
  key: string,
): number | undefined {
  const value = record?.data?.[key];
  return typeof value === "number" ? value : undefined;
}

function toArtifactEntry(
  entry: Extract<ContextEntry, { kind: "transcript" }>,
  record: MicroProjectionRecord,
  path: string,
  recoveryInstruction: string,
): ContextEntry {
  return {
    kind: "toolResultArtifact",
    sourceIndex: entry.sourceIndex,
    message: entry.message as ToolResultTranscriptMessage,
    artifact: {
      id: stringData(record, "artifactId")!,
      path,
      contentDigest: stringData(record, "contentDigest")!,
      originalLength: optionalNumberData(record, "originalLength")!,
      recoveryInstruction,
    },
  };
}
