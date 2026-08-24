import type {
  ProcessExecutionPlan,
  ProcessExecutionRouterPort,
  ProcessResult,
} from "@omni-agent/core";
import { runHostProcess } from "./host-process-runner";
import { runSandboxProcess, type SandboxProcessRuntime } from "./sandbox-process-runner";

/** Executes a fully prepared plan without adding access or runtime capabilities. */
export class ProcessExecutionRouter implements ProcessExecutionRouterPort {
  constructor(private readonly sandboxRuntime: SandboxProcessRuntime) {}

  run(plan: ProcessExecutionPlan, signal?: AbortSignal): Promise<ProcessResult> {
    return plan.route === "sandbox"
      ? runSandboxProcess(plan, this.sandboxRuntime, signal)
      : runHostProcess({ ...plan.invocation, signal });
  }
}
