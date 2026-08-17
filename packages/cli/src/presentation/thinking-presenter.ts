import type { DisclosureViewModel } from "./view-models";
import { formatDuration } from "./format";

interface ThinkingState {
  readonly id: string;
  readonly startedAt: number;
  content: string;
}

export class ThinkingPresenter {
  private readonly blocks = new Map<string, ThinkingState>();

  constructor(private readonly now: () => number = Date.now) {}

  start(modelCallId: string, contentIndex: number): void {
    const key = thinkingKey(modelCallId, contentIndex);
    if (this.blocks.has(key)) return;
    this.blocks.set(key, {
      id: `thinking:${modelCallId}:${contentIndex}`,
      startedAt: this.now(),
      content: "",
    });
  }

  append(modelCallId: string, contentIndex: number, delta: string): DisclosureViewModel | null {
    if (!delta) return null;
    const state = this.getOrStart(modelCallId, contentIndex);
    state.content += delta;
    return this.view(state, "running");
  }

  complete(modelCallId: string, contentIndex: number, content: string): DisclosureViewModel | null {
    const key = thinkingKey(modelCallId, contentIndex);
    const state = this.blocks.get(key);
    if (!state && !content) return null;
    const owned = state ?? this.getOrStart(modelCallId, contentIndex);
    if (content) owned.content = content;
    this.blocks.delete(key);
    if (!owned.content) return null;
    return this.view(owned, "completed", this.now() - owned.startedAt);
  }

  restore(id: string, content: string): DisclosureViewModel | null {
    if (!content) return null;
    return this.view({ id, startedAt: 0, content }, "completed");
  }

  cancelPending(): readonly DisclosureViewModel[] {
    const cancelled = [...this.blocks.values()]
      .filter((state) => state.content)
      .map((state) => this.view(state, "cancelled"));
    this.blocks.clear();
    return cancelled;
  }

  private getOrStart(modelCallId: string, contentIndex: number): ThinkingState {
    const key = thinkingKey(modelCallId, contentIndex);
    this.start(modelCallId, contentIndex);
    return this.blocks.get(key)!;
  }

  private view(
    state: ThinkingState,
    status: "running" | "completed" | "cancelled",
    durationMs?: number,
  ): DisclosureViewModel {
    const content = state.content;
    return {
      id: state.id,
      title: "Thinking",
      ...(durationMs === undefined ? {} : { summary: formatDuration(durationMs) }),
      state: status,
      ...(status === "running" ? { startedAt: state.startedAt } : {}),
      tone: "neutral",
      details: () => [content],
      initiallyExpanded: status === "running",
      collapseOnComplete: true,
    };
  }
}

function thinkingKey(modelCallId: string, contentIndex: number): string {
  return `${modelCallId}:${contentIndex}`;
}
