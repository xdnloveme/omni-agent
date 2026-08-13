export function formatDuration(durationMs: number): string {
  return durationMs >= 1_000 ? `${(durationMs / 1_000).toFixed(1)}s` : `${durationMs}ms`;
}
