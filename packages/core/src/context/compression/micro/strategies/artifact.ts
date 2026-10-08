import { throwIfAborted } from "../../../../execution";
import type { ToolResultTranscriptMessage } from "../../../../messages";
import { digestContextValue } from "../../../digest";
import { cloneContextHistoryFrame } from "../../../policy/types";
import type {
  ContextArtifactRecoveryCapability,
  ContextEntry,
  ContextHistoryFrame,
} from "../../../contracts/types";
import type {
  ContextToolCycleView,
  ContextProjectionStorePort,
  MicroProjectionAssessment,
  MicroProjectionCandidate,
  MicroProjectionOptions,
  MicroProjectionRecord,
  MicroProjectionReplayOptions,
  MicroProjectionResult,
  MicroProjectionStrategyPort,
  MicroStrategyProjectionState,
  PendingContextArtifact,
} from "../contracts";
import { createMicroProjectionCandidate, MINIMUM_MICRO_REDUCTION_RATIO } from "../selector";
import {
  createStrategyState,
  createMicroProjectionAssessment,
  indexProjectionRecords,
  projectionRecordKey,
  projectionReplayDetails,
  projectionSourceKey,
  toolResultProjectionSourceId,
  unchangedProjection,
  validStrategyRecords,
} from "../strategyState";

const PRESERVED_RECENT_RESULTS = 3;

export class ArtifactProjectionStrategy implements MicroProjectionStrategyPort {
  readonly key = "artifact" as const;
  readonly name = "artifact_projection";
  readonly compressionKind = "artifact_projection" as const;
  readonly version = 2;
  private readonly configurationDigest: string;

  constructor(
    private readonly projections: ContextProjectionStorePort,
    private readonly recovery: ContextArtifactRecoveryCapability | undefined,
    private readonly excludedToolNames: readonly string[] = [],
  ) {
    this.configurationDigest = digestContextValue({
      recovery,
      excludedToolNames: [...excludedToolNames].sort(),
      minimumReductionRatio: MINIMUM_MICRO_REDUCTION_RATIO,
      preservedRecentResults: PRESERVED_RECENT_RESULTS,
    });
  }

  createState(): MicroStrategyProjectionState {
    return createStrategyState(this, this.configurationDigest);
  }

  assess(
    frame: Readonly<ContextHistoryFrame>,
    state: Readonly<MicroStrategyProjectionState>,
    options: Readonly<MicroProjectionOptions>,
  ): MicroProjectionAssessment {
    if (!this.recovery) return createMicroProjectionAssessment(this, [], "recovery_unavailable");
    const existing = new Set(validStrategyRecords(state, this).map((record) => record.sourceId));
    const eligible = this.eligibleEntries(frame, options.toolCycles);
    const candidates: MicroProjectionCandidate[] = [];
    let lowSavingsCount = 0;
    for (const entry of eligible.slice(0, -PRESERVED_RECENT_RESULTS)) {
      const message = entry.message as ToolResultTranscriptMessage;
      if (existing.has(toolResultProjectionSourceId(message.toolCallId))) continue;
      const projection = createArtifactProjection(
        entry,
        options.sessionId,
        this.projections,
        this.recovery.instruction,
      );
      const candidate = createMicroProjectionCandidate({
        strategyKey: this.key,
        sourceId: toolResultProjectionSourceId(message.toolCallId),
        original: entry,
        projected: projection.entry,
        lossClass: "recoverable",
        options,
      });
      if (candidate) candidates.push(candidate);
      else lowSavingsCount++;
    }
    return createMicroProjectionAssessment(
      this,
      candidates,
      candidates.length ? "candidates_available" : "no_safe_candidates",
      {
        eligibleCount: eligible.length,
        recentProtectedCount: Math.min(eligible.length, PRESERVED_RECENT_RESULTS),
        lowSavingsCount,
      },
    );
  }

  async replay(
    frame: Readonly<ContextHistoryFrame>,
    state: Readonly<MicroStrategyProjectionState>,
    options: Readonly<MicroProjectionReplayOptions>,
  ): Promise<MicroProjectionResult> {
    const records = validStrategyRecords(state, this);
    if (!this.recovery || records.length === 0)
      return unchangedProjection(frame, this.createState());
    const recordIndex = indexProjectionRecords(records);
    const output = cloneContextHistoryFrame(frame);
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
          sourceId: toolResultProjectionSourceId(
            (entry.message as ToolResultTranscriptMessage).toolCallId,
          ),
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
    const details = projectionReplayDetails(records, retained, replayed);
    return {
      frame: { ...output, entries },
      state: { ...this.createState(), records: retained },
      changed: false,
      artifacts: [],
      ...(details ? { details } : {}),
    };
  }

  async advance(
    frame: Readonly<ContextHistoryFrame>,
    state: Readonly<MicroStrategyProjectionState>,
    selected: readonly Readonly<MicroProjectionCandidate>[],
    options: Readonly<MicroProjectionOptions>,
  ): Promise<MicroProjectionResult> {
    if (!this.recovery) return unchangedProjection(frame, this.createState());
    const records = [...validStrategyRecords(state, this)];
    const selectedIds = new Set(selected.map(projectionSourceKey));
    if (selectedIds.size === 0)
      return unchangedProjection(
        frame,
        createStrategyState(this, this.configurationDigest, records),
      );
    const output = cloneContextHistoryFrame(frame);
    const entries: ContextEntry[] = [];
    const artifacts: PendingContextArtifact[] = [];
    for (const entry of output.entries) {
      throwIfAborted(options.signal);
      if (
        entry.kind !== "transcript" ||
        entry.message.role !== "toolResult" ||
        !selectedIds.has(
          projectionSourceKey({
            sourceId: toolResultProjectionSourceId(entry.message.toolCallId),
            sourceIndex: entry.sourceIndex,
          }),
        )
      ) {
        entries.push(entry);
        continue;
      }
      const transcript = entry as Extract<ContextEntry, { kind: "transcript" }>;
      const message = transcript.message as ToolResultTranscriptMessage;
      const projection = createArtifactProjection(
        transcript,
        options.sessionId,
        this.projections,
        this.recovery.instruction,
      );
      const { content, contentDigest, artifactId } = projection;
      const projected = projection.entry;
      const record: MicroProjectionRecord = {
        kind: "artifact",
        sourceId: toolResultProjectionSourceId(message.toolCallId),
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

  private eligibleEntries(
    frame: Readonly<ContextHistoryFrame>,
    cycles: ContextToolCycleView,
  ): Extract<ContextEntry, { kind: "transcript" }>[] {
    return frame.entries.filter(
      (entry): entry is Extract<ContextEntry, { kind: "transcript" }> =>
        entry.kind === "transcript" &&
        entry.message.role === "toolResult" &&
        !this.excludedToolNames.includes(entry.message.toolName) &&
        isEligible(entry, cycles),
    );
  }
}

function isEligible(
  entry: Extract<ContextEntry, { kind: "transcript" }>,
  cycles: ContextToolCycleView,
): boolean {
  const message = entry.message as ToolResultTranscriptMessage;
  const cycle = cycles.findByResultSourceIndex(entry.sourceIndex);
  return (
    cycle?.status === "completed" &&
    cycle.consumed &&
    !message.isError &&
    !(message.details && typeof message.details === "object" && "output" in message.details) &&
    message.content.every((block) => block.type === "text")
  );
}

function textOf(message: ToolResultTranscriptMessage): string {
  return message.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
}

function createArtifactProjection(
  entry: Extract<ContextEntry, { kind: "transcript" }>,
  sessionId: string,
  projections: ContextProjectionStorePort,
  recoveryInstruction: string,
): {
  readonly entry: Exclude<ContextEntry, { kind: "checkpoint" }>;
  readonly artifactId: string;
  readonly content: string;
  readonly contentDigest: string;
} {
  const message = entry.message as ToolResultTranscriptMessage;
  const content = textOf(message);
  const contentDigest = digestContextValue(content);
  const artifactId = digestContextValue({
    sessionId,
    toolCallId: message.toolCallId,
    contentDigest,
  });
  return {
    entry: {
      kind: "toolResultArtifact",
      sourceIndex: entry.sourceIndex,
      message,
      artifact: {
        id: artifactId,
        path: projections.artifactPath(sessionId, artifactId),
        contentDigest,
        originalLength: content.length,
        recoveryInstruction,
      },
    },
    artifactId,
    content,
    contentDigest,
  };
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
