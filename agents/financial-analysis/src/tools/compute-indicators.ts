import type { AgentTool, ToolResult } from "@omni-agent/core";
import type { OhlcvBar, TechnicalIndicatorSnapshot } from "../domain/types";
import { atr, ema, macd, rsi, sma } from "../indicators/calculations";

export const computeTechnicalIndicatorsTool: AgentTool = {
  name: "financial_compute_technical_indicators",
  strict: true,
  risk: "read",
  approval: "never",
  description: "Compute deterministic SMA, EMA, RSI, MACD, and ATR values from timestamped OHLCV bars.",
  schema: {
    type: "object",
    properties: {
      bars: { type: "array", items: { type: "object" }, description: "OHLCV bars ordered oldest to newest" },
      period: { type: "integer", minimum: 1, default: 14 },
    },
    required: ["bars"],
  },
  async execute(input): Promise<ToolResult> {
    try {
      const bars = parseBars(input.bars);
      const period = typeof input.period === "number" ? input.period : 14;
      const closes = bars.map((bar) => bar.close);
      const snapshot: TechnicalIndicatorSnapshot = {
        timestamp: bars.at(-1)?.timestamp ?? 0,
        sma: sma(closes, period),
        ema: ema(closes, period),
        rsi: rsi(closes, period),
        macd: macd(closes),
        atr: atr(bars, period),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(snapshot, null, 2) }],
        isError: false,
        meta: { kind: "technical_indicators", data: snapshot },
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      };
    }
  },
};

function parseBars(value: unknown): OhlcvBar[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("bars must be a non-empty array");
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object") throw new Error(`bars[${index}] must be an object`);
    const candidate = entry as Record<string, unknown>;
    const fields = ["timestamp", "open", "high", "low", "close", "volume"] as const;
    for (const field of fields) {
      if (typeof candidate[field] !== "number" || !Number.isFinite(candidate[field])) {
        throw new Error(`bars[${index}].${field} must be a finite number`);
      }
    }
    const bar = candidate as unknown as OhlcvBar;
    if (bar.high < bar.low) throw new Error(`bars[${index}].high must be >= low`);
    return bar;
  });
}
