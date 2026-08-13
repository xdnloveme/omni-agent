import { runAgentLoop, type AgentLoopOptions } from "../agent-loop";
import type { AgentConfig, AgentEvent } from "../types";
import type { ModelRuntimePort } from "../models/runtime";
import type { ToolCallCoordinator } from "../tool-calls";
import type { ContextEnginePort, ContextMiddlewarePort } from "../context";
import type { SessionTranscriptSnapshot } from "../session";

/** Host-facing runner with explicit runtime and tool-execution dependencies. */
export class AgentRunner {
  constructor(
    private readonly modelRuntime: ModelRuntimePort,
    private readonly toolCallCoordinator: ToolCallCoordinator,
    private readonly agentId: string,
    private readonly cwd: string,
    private readonly contextEngine: ContextEnginePort,
    private readonly contextMiddleware: readonly ContextMiddlewarePort[] = [],
  ) {}

  run(
    config: AgentConfig,
    snapshot: SessionTranscriptSnapshot,
    signal?: AbortSignal,
    options?: AgentLoopOptions,
  ): AsyncGenerator<AgentEvent> {
    return runAgentLoop({
      config,
      snapshot,
      contextEngine: this.contextEngine,
      contextMiddleware: this.contextMiddleware,
      modelRuntime: this.modelRuntime,
      agentId: this.agentId,
      cwd: this.cwd,
      toolCallCoordinator: this.toolCallCoordinator,
      signal,
      options,
    });
  }
}
