import { describe, expect, it } from "vitest";
import { atr, ema, macd, rsi, sma } from "../indicators/calculations";
import { computeTechnicalIndicatorsTool } from "../tools/compute-indicators";
import type { OhlcvBar } from "../domain/types";

function bars(count: number): OhlcvBar[] {
  return Array.from({ length: count }, (_, index) => ({
    timestamp: index + 1,
    open: index + 10,
    high: index + 12,
    low: index + 9,
    close: index + 11,
    volume: 1_000 + index,
  }));
}

describe("technical indicators", () => {
  it("computes deterministic values and handles insufficient history", () => {
    const input = bars(40);
    const closes = input.map((bar) => bar.close);
    expect(sma(closes, 5)).toBe(48);
    expect(ema(closes, 5)).toBeCloseTo(48, 8);
    expect(rsi(closes, 14)).toBe(100);
    expect(macd(closes)).toMatchObject({ histogram: expect.any(Number) });
    expect(atr(input, 14)).toBeCloseTo(3, 8);
    expect(sma(closes.slice(0, 3), 5)).toBeNull();
  });

  it("returns structured tool metadata without trading actions", async () => {
    if (!("execute" in computeTechnicalIndicatorsTool)) throw new Error("Expected in-process tool");
    const result = await computeTechnicalIndicatorsTool.execute(
      { bars: bars(40), period: 14 },
      { cwd: process.cwd() },
    );
    expect(computeTechnicalIndicatorsTool.access).toEqual({ kind: "internal" });
    expect(computeTechnicalIndicatorsTool.execution).toEqual({ kind: "in_process" });
    expect(result.isError).toBe(false);
    expect(result.meta).toMatchObject({ kind: "technical_indicators" });
    expect(result.content[0].text).toContain('"rsi": 100');
  });

  it("rejects malformed OHLCV data", async () => {
    if (!("execute" in computeTechnicalIndicatorsTool)) throw new Error("Expected in-process tool");
    const result = await computeTechnicalIndicatorsTool.execute(
      { bars: [{ close: 1 }] },
      { cwd: process.cwd() },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("timestamp must be a finite number");
  });
});
