import { homedir } from "node:os";
import { join } from "node:path";
import { createProcessExecutionRuntime, type CliHostServices } from "@omni-agent/cli";
import { createNetworkRuntime } from "@omni-agent/network";
import {
  confirmTerminalAction,
  createAgentConsole,
  createOnboardingInteraction,
  terminalTextPresentation,
} from "@omni-agent/ui/terminal";
import { runTracePreview } from "./trace-preview";
import type { ProcessTerminationPort } from "./process-signals";

export function createCliHostServices(termination: ProcessTerminationPort): CliHostServices {
  const hostRuntime = {
    platform: process.platform,
    path: process.env.PATH ?? "",
    pathExt: process.env.PATHEXT,
    home: homedir(),
    developerDirectory: process.env.DEVELOPER_DIR,
  };
  const processExecution = createProcessExecutionRuntime(hostRuntime);
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
    processRouter: processExecution.router,
    processPlanner: processExecution.planner,
    hostRuntime: processExecution.hostRuntime,
    networkRuntime: createNetworkRuntime(),
    mcpEnvironment: Object.freeze({ ...process.env }),
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
