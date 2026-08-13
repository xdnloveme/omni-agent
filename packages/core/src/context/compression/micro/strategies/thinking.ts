import { throwIfAborted } from "../../../../execution";
import type { AssistantTranscriptMessage } from "../../../../messages";
import { digestContextValue } from "../../../digest";
import { cloneContextFrame } from "../../../policy/types";
import type { ContextEntry, ContextFrame } from "../../../contracts/types";
import type {
  MicroProjectionOptions,
  MicroProjectionRecord,
  MicroProjectionResult,
  MicroProjectionStrategyPort,
  MicroStrategyProjectionState,
  ThinkingHistoryPolicy,
} from "../contracts";
import {
  createStrategyState,
  indexProjectionRecords,
  projectionRecordKey,
  unchangedProjection,
  validStrategyRecords,
} from "../strategyState";

const PRESERVED_RECENT_THINKING = 3;

export class ThinkingProjectionStrategy implements MicroProjectionStrategyPort {
  readonly key = "thinking" as const;
  readonly name = "thinking_projection";
  readonly version = 1;
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
      preservedRecentThinking: PRESERVED_RECENT_THINKING,
    });
  }

  createState(): MicroStrategyProjectionState {
    return createStrategyState(this, this.configurationDigest());
  }

  canAdvance(
    frame: Readonly<ContextFrame>,
    state: Readonly<MicroStrategyProjectionState>,
  ): boolean {
    if (this.currentPolicy() !== "clear_old_text") return false;
    const existing = new Set(validStrategyRecords(state, this).map((record) => record.sourceId));
    return this.selectedCandidates(frame).some(
      (entry) => !existing.has(sourceId(entry.sourceIndex)),
    );
  }

  async replay(
    frame: Readonly<ContextFrame>,
    state: Readonly<MicroStrategyProjectionState>,
    options: Readonly<MicroProjectionOptions>,
  ): Promise<MicroProjectionResult> {
    const records = validStrategyRecords(state, this);
    if (this.currentPolicy() !== "clear_old_text" || records.length === 0) {
      return unchangedProjection(frame, this.createState());
    }
    const recordIndex = indexProjectionRecords(records);
    const output = cloneContextFrame(frame);
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
    return {
      frame: { ...output, entries },
      state: createStrategyState(this, this.configurationDigest(), retained),
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
    if (this.currentPolicy() !== "clear_old_text")
      return unchangedProjection(frame, this.createState());
    const records = [...validStrategyRecords(state, this)];
    const existing = new Set(records.map((record) => record.sourceId));
    const selectedIds = new Set(
      this.selectedCandidates(frame)
        .map((entry) => sourceId(entry.sourceIndex))
        .filter((id) => !existing.has(id)),
    );
    if (selectedIds.size === 0)
      return unchangedProjection(
        frame,
        createStrategyState(this, this.configurationDigest(), records),
      );
    const output = cloneContextFrame(frame);
    const entries = output.entries.map((entry): ContextEntry => {
      throwIfAborted(options.signal);
      if (
        entry.kind !== "transcript" ||
        entry.message.role !== "assistant" ||
        !selectedIds.has(sourceId(entry.sourceIndex))
      ) {
        return entry;
      }
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
      artifacts: [],
      details: { advancedCount: selectedIds.size },
    };
  }

  private selectedCandidates(
    frame: Readonly<ContextFrame>,
  ): Extract<ContextEntry, { kind: "transcript" }>[] {
    const candidates = frame.entries.filter(
      (entry): entry is Extract<ContextEntry, { kind: "transcript" }> =>
        entry.kind === "transcript" &&
        entry.message.role === "assistant" &&
        entry.message.content.some(
          (block) => block.type === "thinking" && block.thinking.length > 0,
        ),
    );
    return candidates.slice(0, -PRESERVED_RECENT_THINKING);
  }
}

function projectThinkingEntry(entry: Extract<ContextEntry, { kind: "transcript" }>): ContextEntry {
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
