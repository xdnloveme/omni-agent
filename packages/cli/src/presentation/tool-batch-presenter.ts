import type {
  ToolBatchDescriptor,
  ToolBatchPosition,
  ToolInvocationPreview,
} from "@omni-agent/core";
import { ToolEventPresenter } from "./tool-event-presenter";
import type { DisclosureViewModel } from "./view-models";
import type { ToolResultView } from "./tool-event-presenter";
import { formatDuration } from "./format";

export interface RestoredToolInvocation {
  readonly toolName: string;
  readonly toolCallId: string;
  readonly input: Record<string, unknown>;
  readonly preview: ToolInvocationPreview;
  readonly result?: ToolResultView;
}

interface BatchState {
  readonly descriptor: ToolBatchDescriptor;
  readonly startedAt: number;
  readonly children: Map<string, DisclosureViewModel>;
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

  restore(
    descriptor: ToolBatchDescriptor,
    invocations: readonly RestoredToolInvocation[],
  ): DisclosureViewModel | null {
    if (descriptor.members.length === 0) return null;
    const byId = new Map(invocations.map((invocation) => [invocation.toolCallId, invocation]));
    const state: BatchState = {
      descriptor: structuredClone(descriptor),
      startedAt: 0,
      children: new Map(
        descriptor.members.map((member) => {
          const invocation = byId.get(member.toolCallId);
          const child = invocation
            ? this.tools.restore(
                invocation.toolName,
                invocation.toolCallId,
                invocation.input,
                invocation.preview,
                invocation.result,
              )
            : {
                ...this.tools.waiting(member.toolName, member.toolCallId, member.preview),
                state: "cancelled" as const,
                tone: "warning" as const,
              };
          return [member.toolCallId, child];
        }),
      ),
    };
    const children = [...state.children.values()];
    if (children.length === 1) return children[0]!;
    const status = children.some((child) => child.state === "failed")
      ? "failed"
      : children.some((child) => child.state === "cancelled")
        ? "cancelled"
        : "completed";
    return { ...this.groupView(state, status), initiallyExpanded: false };
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
      title: "Tool Calls",
      summary:
        status === "running"
          ? `${finished}/${children.length} done${failed ? ` · ${failed} failed` : ""}`
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
  const status =
    failed > 0
      ? `${completed}/${descriptor.members.length} completed · ${failed} failed`
      : `${completed}/${descriptor.members.length} completed`;
  return `${status}${durationMs === undefined ? "" : ` · ${formatDuration(durationMs)}`}`;
}
