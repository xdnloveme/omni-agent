import type {
  ToolBatchDescriptor,
  ToolBatchPosition,
  ToolInvocationPreview,
} from "@omni-agent/core";
import { ToolEventPresenter } from "./tool-event-presenter";
import { describeToolPreview } from "./tool-preview";
import type { DisclosureViewModel } from "./view-models";
import type { ToolResultView } from "./tool-event-presenter";
import { formatDuration } from "./format";

interface BatchState {
  readonly descriptor: ToolBatchDescriptor;
  readonly startedAt: number;
  readonly children: Map<string, DisclosureViewModel>;
  current?: { readonly toolName: string; readonly preview: ToolInvocationPreview };
}

export class ToolBatchPresenter {
  private readonly batches = new Map<string, BatchState>();
  private readonly tools: ToolEventPresenter;

  constructor(private readonly now: () => number = Date.now) {
    this.tools = new ToolEventPresenter(now);
  }

  start(descriptor: ToolBatchDescriptor): DisclosureViewModel | null {
    if (descriptor.members.length === 0) return null;
    const owned = structuredClone(descriptor);
    const state: BatchState = {
      descriptor: owned,
      startedAt: this.now(),
      children: new Map(
        owned.members.map((member) => [
          member.toolCallId,
          this.tools.waiting(member.toolName, member.toolCallId, member.preview),
        ]),
      ),
    };
    this.batches.set(owned.batchId, state);
    return owned.members.length > 1 ? this.groupView(state, "running") : null;
  }

  toolStarted(
    toolName: string,
    toolCallId: string,
    input: Record<string, unknown>,
    preview: ToolInvocationPreview,
    position: ToolBatchPosition,
  ): DisclosureViewModel | null {
    const child = this.tools.start(toolName, toolCallId, input, preview);
    const state = this.batches.get(position.batchId);
    if (state) {
      state.children.set(toolCallId, child);
      state.current = { toolName, preview: structuredClone(preview) };
    }
    if (!state || state.descriptor.members.length === 1) return child;
    return this.groupView(state, "running");
  }

  toolCompleted(
    toolCallId: string,
    result: ToolResultView,
    durationMs: number,
    position: ToolBatchPosition,
  ): DisclosureViewModel | null {
    const child = this.tools.complete(toolCallId, result, durationMs);
    if (!child) return null;
    const state = this.batches.get(position.batchId);
    if (state) {
      state.children.set(toolCallId, child);
      state.current = undefined;
    }
    if (!state || state.descriptor.members.length === 1) return child;
    return this.groupView(state, "running");
  }

  complete(
    batchId: string,
    modelCallId: string,
    durationMs: number,
  ): DisclosureViewModel | null | undefined {
    const state = this.batches.get(batchId);
    if (!state || state.descriptor.modelCallId !== modelCallId) return undefined;
    this.batches.delete(batchId);
    if (state.descriptor.members.length === 1) return null;
    const failed = [...state.children.values()].some((child) => child.state === "failed");
    return this.groupView(state, failed ? "failed" : "completed", durationMs);
  }

  cancelPending(): readonly DisclosureViewModel[] {
    const cancelledChildren = new Map(
      this.tools.cancelPending().map((viewModel) => [viewModel.id, viewModel]),
    );
    const consumedChildren = new Set<string>();
    const cancelled: DisclosureViewModel[] = [];
    for (const state of this.batches.values()) {
      for (const [toolCallId, child] of state.children) {
        if (child.state === "waiting") {
          state.children.set(toolCallId, { ...child, state: "cancelled", tone: "warning" });
        } else {
          const cancelledChild = cancelledChildren.get(child.id);
          if (cancelledChild) consumedChildren.add(child.id);
          state.children.set(toolCallId, cancelledChild ?? child);
        }
      }
      if (state.descriptor.members.length > 1) {
        cancelled.push(this.groupView(state, "cancelled"));
      } else {
        cancelled.push(...state.children.values());
      }
    }
    for (const [id, child] of cancelledChildren) {
      if (!consumedChildren.has(id)) cancelled.push(child);
    }
    this.batches.clear();
    return cancelled;
  }

  private groupView(
    state: BatchState,
    status: "running" | "completed" | "failed" | "cancelled",
    durationMs?: number,
  ): DisclosureViewModel {
    const children = [...state.children.values()];
    const completed = children.filter((child) => child.state === "completed").length;
    const failed = children.filter((child) => child.state === "failed").length;
    const finished = children.filter(
      (child) => child.state === "completed" || child.state === "failed",
    ).length;
    return {
      id: `tool-batch:${state.descriptor.batchId}`,
      title: "Tools",
      summary:
        status === "running"
          ? `${finished}/${children.length} done${failed ? ` · ${failed} failed` : ""}${
              state.current
                ? ` · ${describeToolPreview(state.current.preview, state.current.toolName)}`
                : ""
            }`
          : completedSummary(state.descriptor, completed, failed, durationMs),
      state: status,
      ...(status === "running" ? { startedAt: state.startedAt } : {}),
      tone: status === "failed" ? "error" : status === "cancelled" ? "warning" : "success",
      details: () => [],
      initiallyExpanded: status === "failed" || failed > 0,
      children,
    };
  }
}

function completedSummary(
  descriptor: ToolBatchDescriptor,
  completed: number,
  failed: number,
  durationMs?: number,
): string {
  const counts = new Map<string, number>();
  for (const member of descriptor.members) {
    counts.set(member.toolName, (counts.get(member.toolName) ?? 0) + 1);
  }
  const tools = [...counts]
    .map(([name, count]) => `${name}${count > 1 ? ` ×${count}` : ""}`)
    .join(", ");
  const status =
    failed > 0 ? `${completed} completed · ${failed} failed` : `${completed} completed`;
  return `${status} · ${tools}${durationMs === undefined ? "" : ` · ${formatDuration(durationMs)}`}`;
}
