import type {
  ProcessExecutionPlannerPort,
  ProcessExecutionPlanningRequest,
  ProcessExecutionPlan,
} from "@omni-agent/core";
import { OperationDeadlineSupervisor } from "@omni-agent/core";
import { SandboxProcessError } from "./sandbox-process-error";
import { ExecutableRuntimeProjectionResolver } from "./executable/executable-runtime-projection-resolver";

export class ProcessExecutionPlanner implements ProcessExecutionPlannerPort {
  private readonly supervisor: OperationDeadlineSupervisor;

  constructor(
    private readonly resolver: ExecutableRuntimeProjectionResolver,
    private readonly sandboxSupported: boolean,
    private readonly projectionTimeoutMs: number,
  ) {
    this.supervisor = new OperationDeadlineSupervisor();
  }

  async prepare(request: ProcessExecutionPlanningRequest): Promise<ProcessExecutionPlan> {
    const invocation = await request.tool.createProcessInvocation(request.input, request.context);
    if (invocation.cwd !== request.context.cwd) {
      throw new SandboxProcessError(
        "process_invocation_invalid",
        "Process Tools must use the injected execution working directory.",
      );
    }
    if (request.access.route === "host") return { route: "host", invocation };
    const access = request.access;
    if (!this.sandboxSupported) {
      throw new SandboxProcessError(
        "sandbox_unsupported_platform",
        "Controlled and autonomous execution currently require macOS.",
      );
    }
    const projection = await this.supervisor.run({
      operationName: "sandbox runtime projection",
      timeoutMs: this.projectionTimeoutMs,
      externalSignal: request.context.signal,
      createTimeoutError: () =>
        new SandboxProcessError(
          "sandbox_runtime_projection_timeout",
          "Sandbox runtime dependency inspection timed out.",
        ),
      execute: (signal) =>
        this.resolver.resolve(invocation.command, request.executableRequirements, {
          cwd: invocation.cwd,
          policy: access.policy,
          signal,
        }),
    });
    return {
      route: "sandbox",
      invocation: { ...invocation, command: projection.canonicalExecutablePath },
      policy: access.policy,
      runtimeRead: projection.readScopes,
    };
  }
}
