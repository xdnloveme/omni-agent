import { afterEach, describe, expect, it, vi } from "vitest";
import { StreamAggregator } from "./stream-aggregator";

afterEach(() => {
  vi.useRealTimers();
});

describe("StreamAggregator", () => {
  it("retries a failed scheduled update during terminal flush", async () => {
    vi.useFakeTimers();
    const update = vi
      .fn<(text: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("patch failed"))
      .mockResolvedValue(undefined);
    const aggregator = new StreamAggregator({ intervalMs: 10, update });
    aggregator.replace("complete");

    await vi.advanceTimersByTimeAsync(10);
    await aggregator.close();

    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenLastCalledWith("complete");
  });
});
