import { afterEach, describe, expect, it, vi } from "vitest";
import type { OmniTui } from "../interaction/tui/tui";
import { StreamPresentationRouter } from "./stream-presentation-router";

function createTui() {
  const disclosure = vi.fn();
  const stopActivity = vi.fn();
  const tui = {
    sink: {
      disclosure,
      line: vi.fn(),
      metrics: vi.fn(),
      spacer: vi.fn(),
      writeMarkdown: vi.fn(),
    },
    setActivity: vi.fn(),
    setStatus: vi.fn(),
    stopActivity,
  } as unknown as OmniTui;
  return { tui, disclosure, stopActivity };
}

describe("StreamPresentationRouter", () => {
  afterEach(() => vi.useRealTimers());

  it("renders the first thinking chunk immediately and coalesces later chunks", () => {
    vi.useFakeTimers();
    const { tui, disclosure } = createTui();
    const callbacks = new StreamPresentationRouter(tui).callbacks();
    const identity = { modelCallId: "model", contentIndex: 0 };

    callbacks.onThinkingStart?.({ type: "thinking_start", ...identity });
    callbacks.onThinkingChunk?.({ type: "thinking_delta", ...identity, delta: "one" });
    callbacks.onThinkingChunk?.({ type: "thinking_delta", ...identity, delta: " two" });
    callbacks.onThinkingChunk?.({ type: "thinking_delta", ...identity, delta: " three" });

    expect(disclosure).toHaveBeenCalledOnce();
    expect(disclosure.mock.calls[0]![0].details()).toEqual(["one"]);
    vi.advanceTimersByTime(50);
    expect(disclosure).toHaveBeenCalledTimes(2);
    expect(disclosure.mock.calls[1]![0].details()).toEqual(["one two three"]);
  });

  it("supersedes a pending update with the completed folded view", () => {
    vi.useFakeTimers();
    const { tui, disclosure } = createTui();
    const callbacks = new StreamPresentationRouter(tui).callbacks();
    const identity = { modelCallId: "model", contentIndex: 0 };

    callbacks.onThinkingChunk?.({ type: "thinking_delta", ...identity, delta: "one" });
    callbacks.onThinkingChunk?.({ type: "thinking_delta", ...identity, delta: " two" });
    callbacks.onThinkingEnd?.({
      type: "thinking_end",
      ...identity,
      content: "one two",
    });

    expect(disclosure).toHaveBeenCalledTimes(2);
    expect(disclosure.mock.calls[1]![0]).toMatchObject({
      state: "completed",
      initiallyExpanded: false,
      collapseOnComplete: true,
    });
    vi.runAllTimers();
    expect(disclosure).toHaveBeenCalledTimes(2);
  });

  it("leaves task-level activity teardown to the chat lifecycle", () => {
    const { tui, stopActivity } = createTui();
    const callbacks = new StreamPresentationRouter(tui).callbacks();

    callbacks.onDone?.();
    callbacks.onError?.({ code: "failed", message: "failed", retryable: false });

    expect(stopActivity).not.toHaveBeenCalled();
  });
});
