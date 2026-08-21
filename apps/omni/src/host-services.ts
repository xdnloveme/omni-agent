import type { AgentConsolePort, CliHostServices, HostTermination } from "@omni-agent/cli";
import {
  confirmTerminalAction,
  createAgentConsole,
  createOnboardingInteraction,
  terminalTextPresentation,
} from "@omni-agent/ui/terminal";
import { runTracePreview } from "./trace-preview";

let activeConsole: AgentConsolePort | null = null;

function terminateActive(termination: HostTermination): void {
  activeConsole?.terminate(termination);
}

process.on("SIGINT", () => terminateActive({ kind: "user_interrupt" }));
process.on("SIGTERM", () => terminateActive({ kind: "signal", signal: "SIGTERM" }));

export const cliHostServices: CliHostServices = {
  text: terminalTextPresentation,
  createAgentConsole(options) {
    const consoleView = createAgentConsole(options);
    activeConsole = consoleView;
    return {
      ...consoleView,
      dispose() {
        if (activeConsole === consoleView) activeConsole = null;
        consoleView.dispose();
      },
    };
  },
  createOnboardingInteraction,
  runTracePreview,
  confirm: confirmTerminalAction,
};
