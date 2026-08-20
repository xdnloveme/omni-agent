import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLocalTraceQuery } from "@omni-agent/app";
import { createPreviewServer } from "./preview-server";

export async function runTracePreview(agentId: string): Promise<void> {
  const query = createLocalTraceQuery(join(homedir(), ".omni-agent"), agentId);
  const server = await createPreviewServer(query);
  process.stdout.write(`Trace preview for ${agentId}: ${server.url}\n`);
  openBrowser(server.url);
  await new Promise<void>((resolve) => {
    const close = () => {
      process.off("SIGINT", close);
      process.off("SIGTERM", close);
      void server.close().then(resolve);
    };
    process.on("SIGINT", close);
    process.on("SIGTERM", close);
  });
}

function openBrowser(url: string): void {
  const command: readonly [string, readonly string[]] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  const child = spawn(command[0], command[1], {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => undefined);
  child.unref();
}
