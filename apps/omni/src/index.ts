import { CliUsageError, main } from "@omni-agent/cli";
import { cliHostServices } from "./host-services";

void main(process.argv.slice(2), cliHostServices).catch((error) => {
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
