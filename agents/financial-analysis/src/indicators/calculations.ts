import type { MacdPoint, OhlcvBar } from "../domain/types";

export function sma(values: readonly number[], period: number): number | null {
  validatePeriod(period);
  if (values.length < period) return null;
  const window = values.slice(-period);
  return window.reduce((sum, value) => sum + value, 0) / period;
}

export function emaSeries(values: readonly number[], period: number): number[] {
  validatePeriod(period);
  if (values.length < period) return [];
  const seed = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  const result = [seed];
  const multiplier = 2 / (period + 1);
  for (let index = period; index < values.length; index++) {
    result.push(
      (values[index] - result[result.length - 1]) * multiplier + result[result.length - 1],
    );
  }
  return result;
}

export function ema(values: readonly number[], period: number): number | null {
  return emaSeries(values, period).at(-1) ?? null;
}

export function rsi(values: readonly number[], period = 14): number | null {
  validatePeriod(period);
  if (values.length <= period) return null;
  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= period; index++) {
    const change = values[index] - values[index - 1];
    gains += Math.max(change, 0);
    losses += Math.max(-change, 0);
  }
  let averageGain = gains / period;
  let averageLoss = losses / period;
  for (let index = period + 1; index < values.length; index++) {
    const change = values[index] - values[index - 1];
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
  }
  if (averageLoss === 0) return averageGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + averageGain / averageLoss);
}

export function macd(
  values: readonly number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): MacdPoint | null {
  if (fastPeriod >= slowPeriod) throw new Error("fastPeriod must be smaller than slowPeriod");
  const fast = alignedEma(values, fastPeriod, slowPeriod);
  const slow = emaSeries(values, slowPeriod);
  if (fast.length === 0 || slow.length === 0) return null;
  const macdValues = slow.map((value, index) => fast[index] - value);
  const signalValues = emaSeries(macdValues, signalPeriod);
  const macdValue = macdValues.at(-1);
  const signalValue = signalValues.at(-1);
  if (macdValue === undefined || signalValue === undefined) return null;
  return { macd: macdValue, signal: signalValue, histogram: macdValue - signalValue };
}

export function atr(bars: readonly OhlcvBar[], period = 14): number | null {
  validatePeriod(period);
  if (bars.length <= period) return null;
  const trueRanges: number[] = [];
  for (let index = 1; index < bars.length; index++) {
    const bar = bars[index];
    const previousClose = bars[index - 1].close;
    trueRanges.push(
      Math.max(
        bar.high - bar.low,
        Math.abs(bar.high - previousClose),
        Math.abs(bar.low - previousClose),
      ),
    );
  }
  let value = trueRanges.slice(0, period).reduce((sum, range) => sum + range, 0) / period;
  for (let index = period; index < trueRanges.length; index++) {
    value = (value * (period - 1) + trueRanges[index]) / period;
  }
  return value;
}

function alignedEma(values: readonly number[], period: number, alignPeriod: number): number[] {
  const series = emaSeries(values, period);
  const offset = alignPeriod - period;
  return offset > 0 ? series.slice(offset) : series;
}

function validatePeriod(period: number): void {
  if (!Number.isInteger(period) || period <= 0)
    throw new Error("period must be a positive integer");
}
