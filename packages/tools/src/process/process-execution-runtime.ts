import type {
  HostRuntimeContext,
  ProcessExecutionPlannerPort,
  ProcessExecutionRouterPort,
} from "@omni-agent/core";
import { createHostRuntimeSnapshot } from "./executable/host-runtime-snapshot";
import { ExecutableRuntimeProjectionResolver } from "./executable/executable-runtime-projection-resolver";
import { createProcessPlatformRuntime } from "./executable/platform/process-platform-runtime";
import { systemRuntimeReadProjection } from "./executable/platform/system-runtime-paths";
import type { HostRuntimeEnvironment } from "./executable/types";
import { ProcessExecutionPlanner } from "./process-execution-planner";
import { ProcessExecutionRouter } from "./process-execution-router";
import { SandboxBinaryResolver } from "./sandbox-binary-resolver";

const RUNTIME_PROJECTION_TIMEOUT_MS = 10_000;

export interface ProcessExecutionRuntime {
  readonly planner: ProcessExecutionPlannerPort;
  readonly router: ProcessExecutionRouterPort;
  readonly hostRuntime: HostRuntimeContext;
}

export function createProcessExecutionRuntime(
  environment: HostRuntimeEnvironment,
): ProcessExecutionRuntime {
  const snapshot = createHostRuntimeSnapshot(environment);
  const platform = createProcessPlatformRuntime(snapshot.platform);
  const resolver = new ExecutableRuntimeProjectionResolver(snapshot, platform.dependencyResolvers);
  const sandboxRuntime = {
    snapshot,
    binaryResolver: new SandboxBinaryResolver(),
    systemRead: systemRuntimeReadProjection(snapshot.platform),
  };
  return {
    planner: new ProcessExecutionPlanner(
      resolver,
      platform.sandboxSupported,
      RUNTIME_PROJECTION_TIMEOUT_MS,
    ),
    router: new ProcessExecutionRouter(sandboxRuntime),
    hostRuntime: { platform: snapshot.platform, home: snapshot.home },
  };
}
