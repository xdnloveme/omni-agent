import {
  createProcessExecutionRuntime as createToolsProcessExecutionRuntime,
  type HostRuntimeEnvironment,
  type ProcessExecutionRuntime,
} from "@omni-agent/tools";

export function createProcessExecutionRuntime(
  environment: HostRuntimeEnvironment,
): ProcessExecutionRuntime {
  return createToolsProcessExecutionRuntime(environment);
}
