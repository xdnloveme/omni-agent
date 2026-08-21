import { homedir } from "node:os";
import { join } from "node:path";
import type { CliHostServices } from "@omni-agent/cli";
import {
  confirmTerminalAction,
  createAgentConsole,
  createOnboardingInteraction,
  terminalTextPresentation,
} from "@omni-agent/ui/terminal";
import { runTracePreview } from "./trace-preview";
import type { ProcessTerminationPort } from "./process-signals";

export function createCliHostServices(termination: ProcessTerminationPort): CliHostServices {
  return {
    runtime: {
      cwd: process.cwd(),
      cliEntry: process.argv[1] ?? import.meta.filename,
      globalDirectory: join(homedir(), ".omni-agent"),
      agentPackagesDirectory: join(homedir(), ".omni-agent", "agents"),
      nodeVersion: process.versions.node,
    },
    output: {
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
    },
    text: terminalTextPresentation,
    createAgentConsole(options) {
      const consoleView = createAgentConsole(options);
      const unsubscribe = termination.subscribe((result) => consoleView.terminate(result));
      return {
        ...consoleView,
        dispose() {
          unsubscribe();
          consoleView.dispose();
        },
      };
    },
    createOnboardingInteraction: () => createOnboardingInteraction(termination.signal),
    runTracePreview,
    confirm: (message) => confirmTerminalAction(message, termination.signal),
  };
}
