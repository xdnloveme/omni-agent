export interface OhlcvBar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface MacdPoint {
  macd: number;
  signal: number;
  histogram: number;
}

export interface TechnicalIndicatorSnapshot {
  timestamp: number;
  sma: number | null;
  ema: number | null;
  rsi: number | null;
  macd: MacdPoint | null;
  atr: number | null;
}
