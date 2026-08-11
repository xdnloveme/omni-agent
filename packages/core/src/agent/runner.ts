import { runAgentLoop, type AgentLoopOptions } from "../agent-loop";
import type { AgentMessage } from "../models/messages";
import type { AgentConfig, AgentEvent } from "../types";
import type { ModelRuntimePort } from "../models/runtime";
import type { ToolCallCoordinator } from "../tool-calls";

/** Host-facing runner with explicit runtime and tool-execution dependencies. */
export class AgentRunner {
  constructor(
    private readonly modelRuntime: ModelRuntimePort,
    private readonly toolCallCoordinator: ToolCallCoordinator,
    private readonly agentId: string,
    private readonly cwd: string,
  ) {}

  run(
    config: AgentConfig,
    messages: readonly AgentMessage[],
    signal?: AbortSignal,
    options?: AgentLoopOptions,
  ): AsyncGenerator<AgentEvent> {
    return runAgentLoop({
      config,
      messages,
      modelRuntime: this.modelRuntime,
      agentId: this.agentId,
      cwd: this.cwd,
      toolCallCoordinator: this.toolCallCoordinator,
      signal,
      options,
    });
  }
}
