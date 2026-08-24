import { CliUsageError, parseCliArgs } from "./args";
import { CLI_HELP } from "./help";
import { CLI_VERSION } from "./version";
import { exitCodeForTermination } from "./process-exit";
import type { CliExecutionResult, CliHostServices } from "./host-services";

export { CliUsageError } from "./args";
export { exitCodeForTermination } from "./process-exit";
export type {
  AgentConsolePort,
  CliExecutionResult,
  CliHostServices,
  CliOutputPort,
  CliRuntimeContext,
  HostTermination,
} from "./host-services";
export { createProcessExecutionRuntime } from "./process-runtime";

export async function main(
  args: readonly string[],
  host: CliHostServices,
): Promise<CliExecutionResult> {
  const command = parseCliArgs(args);
  switch (command.kind) {
    case "help":
      host.output.stdout(CLI_HELP);
      return { exitCode: 0 };
    case "version":
      host.output.stdout(`${CLI_VERSION}\n`);
      return { exitCode: 0 };
    case "doctor":
      const { runDoctor } = await import("./diagnostics/doctor");
      return {
        exitCode: (await runDoctor({
          cwd: host.runtime.cwd,
          globalDirectory: host.runtime.globalDirectory,
          nodeVersion: host.runtime.nodeVersion,
          resolutionBase: host.runtime.cliEntry,
          agentPackagesDirectory: host.runtime.agentPackagesDirectory,
          write: host.output.stdout,
        }))
          ? 0
          : 1,
      };
    case "agent-inspection": {
      const { runAgentInspection } = await import("./agent-inspection/controller");
      return runAgentInspection(command.action, command.agentId, command.json, host);
    }
    case "agent-create": {
      const { runAgentScaffold } = await import("./agent-scaffold/controller");
      return runAgentScaffold(command.agentId, command.directory, host);
    }
    case "trace-preview": {
      await host.runTracePreview(command.agentId);
      return { exitCode: 0 };
    }
    case "trace-clear": {
      const { runTraceClear } = await import("./tracing-clear/clear-command");
      await runTraceClear(
        command.agentId,
        command.confirmed,
        host.runtime.globalDirectory,
        host.confirm,
        host.output.stdout,
      );
      return { exitCode: 0 };
    }
    case "run":
      const { runAgentMode } = await import("./modes/run");
      return {
        exitCode: exitCodeForTermination(
          await runAgentMode(command.agentId, host, { trace: command.trace }),
        ),
      };
  }
}
