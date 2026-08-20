export function captureHealth(run) {
  const capture = run?.summary?.capture;
  if (capture?.degraded !== true) return null;
  const droppedRecords = Number.isSafeInteger(capture.droppedRecords) ? capture.droppedRecords : 0;
  return {
    droppedRecords,
    message: `Trace capture is incomplete: ${droppedRecords} ${droppedRecords === 1 ? "record was" : "records were"} dropped under storage pressure.`,
  };
}

export function selectedRun(runId, runs) {
  if (!runId) return null;
  return runs.find((run) => run.runId === runId) ?? null;
}
