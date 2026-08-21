import { createLocalTraceMaintenance } from "@omni-agent/app";

export async function runTraceClear(
  agentId: string,
  confirmed: boolean,
  globalDirectory: string,
  confirm: (message: string) => Promise<boolean>,
  write: (text: string) => void,
): Promise<void> {
  const trace = createLocalTraceMaintenance(globalDirectory, agentId);
  const bytes = await trace.diskUsage();
  const accepted =
    confirmed || (await confirm(`Clear ${formatBytes(bytes)} of local Trace data for ${agentId}?`));
  if (!accepted) {
    write("Trace clear cancelled.\n");
    return;
  }
  await trace.clear();
  write(`Cleared local Trace data for ${agentId}.\n`);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
