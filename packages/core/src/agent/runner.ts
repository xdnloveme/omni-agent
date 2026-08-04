import { runAgentLoop, type AgentLoopOptions } from "../agent-loop";
import type { AgentConfig, AgentEvent, Message } from "../types";

/** Stable object-oriented entry point for hosts; runAgentLoop remains compatible. */
export class AgentRunner {
  run(
    config: AgentConfig,
    messages: Message[],
    signal?: AbortSignal,
    options?: AgentLoopOptions,
  ): AsyncGenerator<AgentEvent> {
    return runAgentLoop(config, messages, signal, options);
  }
}
