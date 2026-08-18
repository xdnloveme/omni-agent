export function formatDuration(durationMs: number): string {
  return durationMs >= 1_000 ? `${(durationMs / 1_000).toFixed(1)}s` : `${durationMs}ms`;
}

export function formatElapsedTime(durationMs: number): string {
  const totalSeconds = Math.floor(durationMs / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
}
