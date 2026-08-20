import type { AgentTraceControlCapability } from "@omni-agent/app";
import type { Command } from "@omni-agent/core";

export function createTraceCommand(trace: AgentTraceControlCapability): Command {
  return {
    name: "trace",
    description: "Control local Agent trace capture",
    async execute(context) {
      const action = context.args.trim() || "status";
      if (action === "start") {
        trace.control.start();
        context.interaction.line(
          "Trace capture enabled. Future runs will store sanitized model and tool data locally.",
        );
      } else if (action === "stop") {
        trace.control.stop();
        context.interaction.line("Trace capture disabled for future runs.");
      } else if (action === "status") {
        context.interaction.line(`Trace capture is ${trace.control.status()}.`);
        context.interaction.line(`Location: ${trace.inspection.location()}`);
        context.interaction.line(`Disk usage: ${formatBytes(await trace.inspection.diskUsage())}`);
        context.interaction.line(`Active runs: ${await trace.inspection.activeRuns()}`);
      } else {
        throw new Error("Usage: /trace start|stop|status");
      }
      context.interaction.spacer();
    },
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
