import { throwIfAborted } from "../../../../execution";
import type { AssistantTranscriptMessage } from "../../../../messages";
import { digestContextValue } from "../../../digest";
import { cloneContextHistoryFrame } from "../../../policy/types";
import type { ContextEntry, ContextHistoryFrame } from "../../../contracts/types";
import type {
  MicroProjectionAssessment,
  MicroProjectionCandidate,
  MicroProjectionOptions,
  MicroProjectionRecord,
  MicroProjectionReplayOptions,
  MicroProjectionResult,
  MicroProjectionStrategyPort,
  MicroStrategyProjectionState,
  ThinkingHistoryPolicy,
} from "../contracts";
import { createMicroProjectionCandidate, MINIMUM_MICRO_REDUCTION_RATIO } from "../selector";
import {
  createStrategyState,
  createMicroProjectionAssessment,
  indexProjectionRecords,
  projectionRecordKey,
  projectionReplayDetails,
  projectionSourceKey,
  unchangedProjection,
  validStrategyRecords,
} from "../strategyState";

const PRESERVED_RECENT_THINKING = 3;

export class ThinkingProjectionStrategy implements MicroProjectionStrategyPort {
  readonly key = "thinking" as const;
  readonly name = "thinking_projection";
  readonly compressionKind = "thinking_projection" as const;
  readonly version = 2;
  constructor(private readonly policy: () => ThinkingHistoryPolicy) {
    this.currentPolicy();
  }

  private currentPolicy(): ThinkingHistoryPolicy {
    const policy = this.policy();
    if (!(["preserve_all", "clear_old_text"] as const).includes(policy)) {
      throw new Error(`Invalid Thinking history policy: ${String(policy)}`);
    }
    return policy;
  }

  private configurationDigest(): string {
    return digestContextValue({
      policy: this.currentPolicy(),
      minimumReductionRatio: MINIMUM_MICRO_REDUCTION_RATIO,
      preservedRecentThinking: PRESERVED_RECENT_THINKING,
    });
  }

  createState(): MicroStrategyProjectionState {
    return createStrategyState(this, this.configurationDigest());
  }

  assess(
    frame: Readonly<ContextHistoryFrame>,
    state: Readonly<MicroStrategyProjectionState>,
    options: Readonly<MicroProjectionOptions>,
  ): MicroProjectionAssessment {
    if (this.currentPolicy() !== "clear_old_text") {
      return createMicroProjectionAssessment(this, [], "policy_preserves_all");
    }
    const existing = new Set(validStrategyRecords(state, this).map((record) => record.sourceId));
    const eligible = this.eligibleEntries(frame);
    const candidates: MicroProjectionCandidate[] = [];
    let lowSavingsCount = 0;
    for (const entry of eligible.slice(0, -PRESERVED_RECENT_THINKING)) {
      const id = sourceId(entry.sourceIndex);
      if (existing.has(id)) continue;
      const projected = projectThinkingEntry(entry);
      const candidate = createMicroProjectionCandidate({
        strategyKey: this.key,
        sourceId: id,
        original: entry,
        projected,
        lossClass: "discardable",
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
        recentProtectedCount: Math.min(eligible.length, PRESERVED_RECENT_THINKING),
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
    if (this.currentPolicy() !== "clear_old_text" || records.length === 0) {
      return unchangedProjection(frame, this.createState());
    }
    const recordIndex = indexProjectionRecords(records);
    const output = cloneContextHistoryFrame(frame);
    let replayed = 0;
    const retained: MicroProjectionRecord[] = [];
    const entries = output.entries.map((entry): ContextEntry => {
      throwIfAborted(options.signal);
      if (entry.kind !== "transcript" || entry.message.role !== "assistant") return entry;
      const record = recordIndex.get(
        projectionRecordKey({
          sourceId: sourceId(entry.sourceIndex),
          sourceIndex: entry.sourceIndex,
          sourceDigest: digestContextValue(entry.message),
        }),
      );
      if (!record) return entry;
      const projected = projectThinkingEntry(entry);
      if (digestContextValue(projected) !== record.projectionDigest) return entry;
      replayed++;
      retained.push(record);
      return projected;
    });
    const details = projectionReplayDetails(records, retained, replayed);
    return {
      frame: { ...output, entries },
      state: createStrategyState(this, this.configurationDigest(), retained),
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
    if (this.currentPolicy() !== "clear_old_text")
      return unchangedProjection(frame, this.createState());
    const records = [...validStrategyRecords(state, this)];
    const selectedIds = new Set(selected.map(projectionSourceKey));
    if (selectedIds.size === 0)
      return unchangedProjection(
        frame,
        createStrategyState(this, this.configurationDigest(), records),
      );
    const output = cloneContextHistoryFrame(frame);
    let affectedCount = 0;
    const entries = output.entries.map((entry): ContextEntry => {
      throwIfAborted(options.signal);
      if (
        entry.kind !== "transcript" ||
        entry.message.role !== "assistant" ||
        !selectedIds.has(
          projectionSourceKey({
            sourceId: sourceId(entry.sourceIndex),
            sourceIndex: entry.sourceIndex,
          }),
        )
      ) {
        return entry;
      }
      affectedCount += entry.message.content.filter(
        (block) => block.type === "thinking" && block.thinking.length > 0,
      ).length;
      const projected = projectThinkingEntry(entry);
      records.push({
        kind: "thinking",
        sourceId: sourceId(entry.sourceIndex),
        sourceIndex: entry.sourceIndex,
        sourceDigest: digestContextValue(entry.message),
        projectionDigest: digestContextValue(projected),
      });
      return projected;
    });
    return {
      frame: { ...output, entries },
      state: createStrategyState(this, this.configurationDigest(), records),
      changed: true,
      affectedCount,
      artifacts: [],
      details: { advancedCount: selectedIds.size },
    };
  }

  private eligibleEntries(
    frame: Readonly<ContextHistoryFrame>,
  ): Extract<ContextEntry, { kind: "transcript" }>[] {
    return frame.entries.filter(
      (entry): entry is Extract<ContextEntry, { kind: "transcript" }> =>
        entry.kind === "transcript" &&
        entry.message.role === "assistant" &&
        entry.message.content.some(
          (block) => block.type === "thinking" && block.thinking.length > 0,
        ),
    );
  }
}

function projectThinkingEntry(
  entry: Extract<ContextEntry, { kind: "transcript" }>,
): Extract<ContextEntry, { kind: "transcript" }> {
  const message = entry.message as AssistantTranscriptMessage;
  return {
    ...entry,
    message: {
      ...message,
      content: message.content.map((block) =>
        block.type === "thinking" ? { ...block, thinking: "" } : block,
      ),
    },
  };
}

function sourceId(sourceIndex: number): string {
  return `assistant:${sourceIndex}`;
}
