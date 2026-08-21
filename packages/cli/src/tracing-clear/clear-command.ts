import { homedir } from "node:os";
import { join } from "node:path";
import { createLocalTraceMaintenance } from "@omni-agent/app";

export async function runTraceClear(
  agentId: string,
  confirmed: boolean,
  confirm: (message: string) => Promise<boolean>,
): Promise<void> {
  const trace = createLocalTraceMaintenance(join(homedir(), ".omni-agent"), agentId);
  const bytes = await trace.diskUsage();
  const accepted =
    confirmed || (await confirm(`Clear ${formatBytes(bytes)} of local Trace data for ${agentId}?`));
  if (!accepted) {
    process.stdout.write("Trace clear cancelled.\n");
    return;
  }
  await trace.clear();
  process.stdout.write(`Cleared local Trace data for ${agentId}.\n`);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
