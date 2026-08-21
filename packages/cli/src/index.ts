import { CliUsageError, parseCliArgs } from "./args";
import { CLI_HELP } from "./help";
import { CLI_VERSION } from "./version";
import { exitCodeForTermination } from "./process-exit";
import type { CliHostServices } from "./host-services";

export { CliUsageError } from "./args";
export type { AgentConsolePort, CliHostServices, HostTermination } from "./host-services";

export async function main(args: readonly string[], host: CliHostServices): Promise<void> {
  const command = parseCliArgs(args);
  switch (command.kind) {
    case "help":
      process.stdout.write(CLI_HELP);
      return;
    case "version":
      process.stdout.write(`${CLI_VERSION}\n`);
      return;
    case "doctor":
      const { runDoctor } = await import("./diagnostics/doctor");
      if (!(await runDoctor())) process.exitCode = 1;
      return;
    case "trace-preview": {
      await host.runTracePreview(command.agentId);
      return;
    }
    case "trace-clear": {
      const { runTraceClear } = await import("./tracing-clear/clear-command");
      await runTraceClear(command.agentId, command.confirmed, host.confirm);
      return;
    }
    case "run":
      const { runAgentMode } = await import("./modes/run");
      process.exitCode = exitCodeForTermination(
        await runAgentMode(command.agentId, host, { trace: command.trace }),
      );
  }
}
