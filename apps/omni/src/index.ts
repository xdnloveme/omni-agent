import { CliUsageError, exitCodeForTermination, main } from "@omni-agent/cli";
import { createCliHostServices } from "./host-services";
import { ProcessTerminationController, registerProcessSignals } from "./process-signals";

const termination = new ProcessTerminationController();
const cliHostServices = createCliHostServices(termination);
const signals = registerProcessSignals((result) => termination.terminate(result));
void main(process.argv.slice(2), cliHostServices)
  .then((result) => {
    process.exitCode = result.exitCode;
  })
  .catch((error) => {
    if (error instanceof CliUsageError) {
      cliHostServices.output.stderr(`${error.message}\nRun 'omni --help' for usage.\n`);
      process.exitCode = 2;
      return;
    }
    if (error instanceof Error && error.name === "AbortError") {
      process.exitCode = exitCodeForTermination(termination.current ?? { kind: "user_interrupt" });
      return;
    }
    cliHostServices.output.stderr(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  })
  .finally(() => signals.dispose());
