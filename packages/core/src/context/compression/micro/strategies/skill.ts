import { throwIfAborted } from "../../../../execution";
import type { ToolResultTranscriptMessage } from "../../../../messages";
import { digestContextValue } from "../../../digest";
import { cloneContextFrame } from "../../../policy/types";
import type { ContextEntry, ContextFrame } from "../../../contracts/types";
import type {
  MicroProjectionOptions,
  MicroProjectionRecord,
  MicroProjectionResult,
  MicroProjectionStrategyPort,
  MicroStrategyProjectionState,
} from "../contracts";
import {
  createStrategyState,
  indexProjectionRecords,
  projectionRecordKey,
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
  readonly version = 1;
  private readonly configurationDigest: string;

  constructor(private readonly configuration: SkillProjectionConfiguration | undefined) {
    if (configuration && (!configuration.resultKind.trim() || !configuration.toolName.trim())) {
      throw new Error("Skill projection requires a result kind and tool name");
    }
    this.configurationDigest = digestContextValue({
      configuration,
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
    if (!this.configuration) return false;
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
    if (!this.configuration || records.length === 0) {
      return unchangedProjection(frame, this.createState());
    }
    const recordIndex = indexProjectionRecords(records);
    const output = cloneContextFrame(frame);
    let replayed = 0;
    const retained: MicroProjectionRecord[] = [];
    const entries = output.entries.map((entry): ContextEntry => {
      throwIfAborted(options.signal);
      if (entry.kind !== "transcript" || entry.message.role !== "toolResult") return entry;
      const record = recordIndex.get(
        projectionRecordKey({
          sourceId: sourceId(entry.message as ToolResultTranscriptMessage),
          sourceIndex: entry.sourceIndex,
          sourceDigest: digestContextValue(entry.message),
        }),
      );
      if (!record) return entry;
      const projected = projectSkillEntry(entry, skillName(record), this.configuration!.toolName);
      if (digestContextValue(projected) !== record.projectionDigest) return entry;
      replayed++;
      retained.push(record);
      return projected;
    });
    return {
      frame: { ...output, entries },
      state: createStrategyState(this, this.configurationDigest, retained),
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
    if (!this.configuration) return unchangedProjection(frame, this.createState());
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
    const entries = output.entries.map((entry): ContextEntry => {
      throwIfAborted(options.signal);
      if (entry.kind !== "transcript" || entry.message.role !== "toolResult") return entry;
      const id = sourceId(entry.message);
      if (!selectedIds.has(id)) return entry;
      const name = messageSkillName(entry.message);
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

  private selectedCandidates(
    frame: Readonly<ContextFrame>,
  ): Extract<ContextEntry, { kind: "transcript" }>[] {
    if (!this.configuration) return [];
    const candidates = frame.entries.filter(
      (entry): entry is Extract<ContextEntry, { kind: "transcript" }> =>
        entry.kind === "transcript" &&
        entry.message.role === "toolResult" &&
        !entry.message.isError &&
        detailsKind(entry.message.details) === this.configuration!.resultKind,
    );
    return candidates.slice(0, -PRESERVED_RECENT_RESULTS);
  }
}

function projectSkillEntry(
  entry: Extract<ContextEntry, { kind: "transcript" }>,
  name: string,
  toolName: string,
): ContextEntry {
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

function sourceId(message: ToolResultTranscriptMessage): string {
  return `toolResult:${message.toolCallId}`;
}

function detailsKind(details: unknown): string | undefined {
  if (!details || typeof details !== "object") return undefined;
  const value = (details as Record<string, unknown>).kind;
  return typeof value === "string" ? value : undefined;
}

function messageSkillName(message: ToolResultTranscriptMessage): string {
  if (!message.details || typeof message.details !== "object") return "unknown";
  const value = (message.details as Record<string, unknown>).skillName;
  return typeof value === "string" && value.length > 0 ? value : "unknown";
}

function skillName(record: MicroProjectionRecord): string {
  const value = record.data?.skillName;
  return typeof value === "string" ? value : "unknown";
}
