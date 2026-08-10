import { runAgentLoop, type AgentLoopOptions } from "../agent-loop";
import type { AgentMessage } from "../models/messages";
import type { AgentConfig, AgentEvent } from "../types";
import type { ModelRuntimePort } from "../models/runtime";
import { ToolExecutor } from "../tools/executor";

/** Host-facing runner with explicit runtime and tool-execution dependencies. */
export class AgentRunner {
  constructor(
    private readonly modelRuntime: ModelRuntimePort,
    private readonly toolExecutor = new ToolExecutor(),
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
      toolExecutor: this.toolExecutor,
      signal,
      options,
    });
  }
}
