import { afterEach, describe, expect, it, vi } from "vitest";
import type { TextDeltaEvent } from "@omni-agent/core";
import type { OmniTui } from "../runtime/tui";
import type { RunPresentationViewModel } from "./view-models";
import { StreamPresentationRouter } from "./stream-presentation-router";

function textDelta(modelCallId: string, delta: string): TextDeltaEvent {
  return {
    type: "text_delta",
    modelCallId,
    textSegmentId: `${modelCallId}:text:0`,
    delta,
  };
}

function createTui() {
  const projections: RunPresentationViewModel[] = [];
  const tui = {
    sink: {
      renderRun: vi.fn((viewModel: RunPresentationViewModel) => projections.push(viewModel)),
    },
    setActivity: vi.fn(),
    setStatus: vi.fn(),
    stopActivity: vi.fn(),
  } as unknown as OmniTui;
  return { tui, projections };
}

describe("StreamPresentationRouter", () => {
  afterEach(() => vi.useRealTimers());

  it("renders the first thinking chunk immediately and coalesces later chunks", () => {
    vi.useFakeTimers();
    const { tui, projections } = createTui();
    const callbacks = new StreamPresentationRouter(tui).callbacks();
    const identity = { modelCallId: "model", contentIndex: 0 };

    callbacks.onThinkingStart?.({ type: "thinking_start", ...identity });
    callbacks.onThinkingChunk?.({ type: "thinking_delta", ...identity, delta: "one" });
    const afterFirstChunk = projections.at(-1);
    expect(afterFirstChunk?.processNodes.at(-1)).toMatchObject({
      kind: "disclosure",
      disclosure: expect.objectContaining({ id: "thinking:model:0" }),
    });

    callbacks.onThinkingChunk?.({ type: "thinking_delta", ...identity, delta: " two" });
    callbacks.onThinkingChunk?.({ type: "thinking_delta", ...identity, delta: " three" });
    vi.advanceTimersByTime(50);

    const disclosure = projections.at(-1)?.processNodes.at(-1);
    expect(disclosure?.kind).toBe("disclosure");
    if (disclosure?.kind === "disclosure") {
      expect(disclosure.disclosure.details()).toEqual(["one two three"]);
    }
  });

  it("streams each model call into a stable node and marks only the explicit identity final", () => {
    vi.useFakeTimers();
    const { tui, projections } = createTui();
    const callbacks = new StreamPresentationRouter(tui).callbacks();

    callbacks.onTextChunk?.(textDelta("call-1", "checking"));
    callbacks.onToolBatchStart?.({
      type: "tool_batch_started",
      batch: { batchId: "batch", modelCallId: "call-1", members: [] },
    });
    callbacks.onTextChunk?.(textDelta("call-2", "final "));
    callbacks.onTextChunk?.(textDelta("call-2", "answer"));

    expect(projections).toHaveLength(1);
    callbacks.onFinalResponse?.({ type: "final_response", modelCallId: "call-2" });

    const finalProjection = projections.at(-1);
    expect(finalProjection?.finalNode).toMatchObject({
      modelCallId: "call-2",
      markdown: "final answer",
    });
    expect(finalProjection?.processNodes).toContainEqual(
      expect.objectContaining({ kind: "text", modelCallId: "call-1", markdown: "checking" }),
    );
  });

  it("keeps cache metadata outside process nodes and places metrics after completion", () => {
    const { tui, projections } = createTui();
    const callbacks = new StreamPresentationRouter(tui).callbacks();

    callbacks.onTextChunk?.(textDelta("call", "final"));
    callbacks.onModelCacheReport?.({
      outcome: "success",
      contextSnapshotId: "snapshot",
      cacheHitRate: 0.9,
    } as Parameters<NonNullable<typeof callbacks.onModelCacheReport>>[0]);
    callbacks.onFinalResponse?.({ type: "final_response", modelCallId: "call" });
    callbacks.onDone?.({
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      contextWindow: 100,
      usableInputBudget: 80,
      requestedOutputTokens: 20,
    });

    const projection = projections.at(-1);
    expect(projection?.state).toBe("completed");
    expect(projection?.metrics).toBeDefined();
    expect(projection?.processNodes).not.toContainEqual(
      expect.objectContaining({ kind: "plain", text: expect.stringContaining("Cache") }),
    );
  });

  it("leaves task-level activity teardown to the chat lifecycle", () => {
    const { tui } = createTui();
    const callbacks = new StreamPresentationRouter(tui).callbacks();

    callbacks.onDone?.();
    expect(tui.stopActivity).not.toHaveBeenCalled();
  });

  it("settles pending disclosures before publishing a failed run", () => {
    const { tui, projections } = createTui();
    const callbacks = new StreamPresentationRouter(tui).callbacks();

    callbacks.onThinkingChunk?.({
      type: "thinking_delta",
      modelCallId: "model",
      contentIndex: 0,
      delta: "partial reasoning",
    });
    callbacks.onError?.({ code: "failed", message: "provider failed", retryable: false });

    const projection = projections.at(-1);
    expect(projection).toMatchObject({ state: "failed" });
    expect(projection?.processNodes).toContainEqual(
      expect.objectContaining({
        kind: "disclosure",
        disclosure: expect.objectContaining({ state: "cancelled" }),
      }),
    );
    expect(projection?.processNodes).toContainEqual(
      expect.objectContaining({ kind: "plain", text: "Error: provider failed" }),
    );
  });
});
