import { throwIfAborted } from "../../../../execution";
import type { ToolResultTranscriptMessage } from "../../../../messages";
import { digestContextValue } from "../../../digest";
import { cloneContextHistoryFrame } from "../../../policy/types";
import type { ContextEntry, ContextHistoryFrame } from "../../../contracts/types";
import type {
  ContextToolCycleView,
  MicroProjectionAssessment,
  MicroProjectionCandidate,
  MicroProjectionOptions,
  MicroProjectionRecord,
  MicroProjectionReplayOptions,
  MicroProjectionResult,
  MicroProjectionStrategyPort,
  MicroStrategyProjectionState,
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

export interface SkillProjectionConfiguration {
  readonly resultKind: string;
  readonly toolName: string;
}

export class SkillProjectionStrategy implements MicroProjectionStrategyPort {
  readonly key = "skill" as const;
  readonly name = "skill_projection";
  readonly compressionKind = "skill_projection" as const;
  readonly version = 2;
  private readonly configurationDigest: string;

  constructor(private readonly configuration: SkillProjectionConfiguration | undefined) {
    if (configuration && (!configuration.resultKind.trim() || !configuration.toolName.trim())) {
      throw new Error("Skill projection requires a result kind and tool name");
    }
    this.configurationDigest = digestContextValue({
      configuration,
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
    if (!this.configuration)
      return createMicroProjectionAssessment(this, [], "configuration_unavailable");
    const existing = new Set(validStrategyRecords(state, this).map((record) => record.sourceId));
    const eligible = this.eligibleEntries(frame, options.toolCycles);
    const candidates: MicroProjectionCandidate[] = [];
    let lowSavingsCount = 0;
    for (const entry of eligible.slice(0, -PRESERVED_RECENT_RESULTS)) {
      const message = entry.message as ToolResultTranscriptMessage;
      const name = messageSkillName(message);
      if (!name || existing.has(toolResultProjectionSourceId(message.toolCallId))) continue;
      const projected = projectSkillEntry(entry, name, this.configuration.toolName);
      const candidate = createMicroProjectionCandidate({
        strategyKey: this.key,
        sourceId: toolResultProjectionSourceId(message.toolCallId),
        original: entry,
        projected,
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
    if (!this.configuration || records.length === 0) {
      return unchangedProjection(frame, this.createState());
    }
    const recordIndex = indexProjectionRecords(records);
    const output = cloneContextHistoryFrame(frame);
    let replayed = 0;
    const retained: MicroProjectionRecord[] = [];
    const entries = output.entries.map((entry): ContextEntry => {
      throwIfAborted(options.signal);
      if (entry.kind !== "transcript" || entry.message.role !== "toolResult") return entry;
      const record = recordIndex.get(
        projectionRecordKey({
          sourceId: toolResultProjectionSourceId(
            (entry.message as ToolResultTranscriptMessage).toolCallId,
          ),
          sourceIndex: entry.sourceIndex,
          sourceDigest: digestContextValue(entry.message),
        }),
      );
      if (!record) return entry;
      const name = skillName(record);
      if (!name) return entry;
      const projected = projectSkillEntry(entry, name, this.configuration!.toolName);
      if (digestContextValue(projected) !== record.projectionDigest) return entry;
      replayed++;
      retained.push(record);
      return projected;
    });
    const details = projectionReplayDetails(records, retained, replayed);
    return {
      frame: { ...output, entries },
      state: createStrategyState(this, this.configurationDigest, retained),
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
    if (!this.configuration) return unchangedProjection(frame, this.createState());
    const records = [...validStrategyRecords(state, this)];
    const selectedIds = new Set(selected.map(projectionSourceKey));
    if (selectedIds.size === 0)
      return unchangedProjection(
        frame,
        createStrategyState(this, this.configurationDigest, records),
      );
    const output = cloneContextHistoryFrame(frame);
    const entries = output.entries.map((entry): ContextEntry => {
      throwIfAborted(options.signal);
      if (entry.kind !== "transcript" || entry.message.role !== "toolResult") return entry;
      const id = toolResultProjectionSourceId(entry.message.toolCallId);
      if (!selectedIds.has(projectionSourceKey({ sourceId: id, sourceIndex: entry.sourceIndex })))
        return entry;
      const name = messageSkillName(entry.message);
      if (!name) return entry;
      const projected = projectSkillEntry(entry, name, this.configuration!.toolName);
      records.push({
        kind: "skill",
        sourceId: id,
        sourceIndex: entry.sourceIndex,
        sourceDigest: digestContextValue(entry.message),
        projectionDigest: digestContextValue(projected),
        data: { skillName: name },
      });
      return projected;
    });
    return {
      frame: { ...output, entries },
      state: createStrategyState(this, this.configurationDigest, records),
      changed: true,
      affectedCount: selectedIds.size,
      artifacts: [],
      details: { advancedCount: selectedIds.size },
    };
  }

  private eligibleEntries(
    frame: Readonly<ContextHistoryFrame>,
    cycles: ContextToolCycleView,
  ): Extract<ContextEntry, { kind: "transcript" }>[] {
    if (!this.configuration) return [];
    return frame.entries.filter(
      (entry): entry is Extract<ContextEntry, { kind: "transcript" }> =>
        entry.kind === "transcript" &&
        entry.message.role === "toolResult" &&
        !entry.message.isError &&
        detailsKind(entry.message.details) === this.configuration!.resultKind &&
        isCompletedConsumedCycle(entry.sourceIndex, cycles),
    );
  }
}

function projectSkillEntry(
  entry: Extract<ContextEntry, { kind: "transcript" }>,
  name: string,
  toolName: string,
): Extract<ContextEntry, { kind: "transcript" }> {
  return {
    ...entry,
    message: {
      ...(entry.message as ToolResultTranscriptMessage),
      content: [
        {
          type: "text",
          text: `[Skill instructions externalized: ${name}]\nUse ${toolName} with name ${JSON.stringify(name)} when the full instructions are needed again.`,
        },
      ],
    },
  };
}

function isCompletedConsumedCycle(sourceIndex: number, cycles: ContextToolCycleView): boolean {
  const cycle = cycles.findByResultSourceIndex(sourceIndex);
  return cycle?.status === "completed" && cycle.consumed;
}

function detailsKind(details: unknown): string | undefined {
  if (!details || typeof details !== "object") return undefined;
  const value = (details as Record<string, unknown>).kind;
  return typeof value === "string" ? value : undefined;
}

function messageSkillName(message: ToolResultTranscriptMessage): string | undefined {
  if (!message.details || typeof message.details !== "object") return undefined;
  const value = (message.details as Record<string, unknown>).skillName;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function skillName(record: MicroProjectionRecord): string | undefined {
  const value = record.data?.skillName;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
