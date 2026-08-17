import { CliUsageError, parseCliArgs } from "./args";
import { CLI_HELP } from "./help";
import { CLI_VERSION } from "./version";
import { exitCodeForTermination } from "./process-exit";

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<void> {
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
    case "run":
      const { runAgentMode } = await import("./modes/run");
      process.exitCode = exitCodeForTermination(await runAgentMode(command.agentId));
  }
}

void main().catch((error) => {
  if (error instanceof CliUsageError) {
    console.error(error.message);
    console.error("Run 'omni --help' for usage.");
    process.exitCode = 2;
    return;
  }
  if (error instanceof Error && error.name === "AbortError") {
    process.exitCode = 130;
    return;
  }
  console.error(error);
  process.exitCode = 1;
});
