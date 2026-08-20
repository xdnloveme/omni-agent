import {
  isAbortError,
  type AgentFailure,
  type StreamCallbacks,
  type TokenUsage,
} from "@omni-agent/core";
import type { RuntimeRunObservation } from "@omni-agent/core/host";
import type { AgentScopedTraceRuntime, TraceRunScope } from "./agent-scoped-trace-runtime";
import type { TraceRunManifest } from "./trace-schema";

export class AgentRunTrace {
  private terminalFailure: AgentFailure | undefined;
  private terminalUsage: TokenUsage | undefined;

  constructor(
    private readonly runtime: AgentScopedTraceRuntime,
    private readonly scope: TraceRunScope,
    private readonly observation: RuntimeRunObservation,
  ) {}

  callbacks(callbacks: StreamCallbacks): StreamCallbacks {
    return {
      ...callbacks,
      onDone: (usage) => {
        this.terminalUsage = usage;
        callbacks.onDone?.(usage);
      },
      onError: (failure) => {
        this.terminalFailure = failure;
        callbacks.onError?.(failure);
      },
    };
  }

  start(input: string): void {
    this.observation.userInput({ input });
  }

  execute(operation: () => Promise<void>): Promise<void> {
    return this.observation.run(operation);
  }

  async complete(): Promise<void> {
    const status = this.terminalFailure ? "error" : "completed";
    this.observation.complete({
      ...(this.terminalUsage ? { usage: this.terminalUsage } : {}),
      ...(this.terminalFailure ? { failure: this.terminalFailure } : {}),
    });
    await this.finish(status, {
      ...(this.terminalUsage ? { usage: this.terminalUsage } : {}),
      ...(this.terminalFailure ? { failure: this.terminalFailure } : {}),
    });
  }

  async fail(error: unknown, signal?: AbortSignal): Promise<void> {
    const cancelled = isAbortError(error, signal);
    const failure = { message: error instanceof Error ? error.message : String(error) };
    const runtimeFailure = {
      code: cancelled ? "run_cancelled" : "run_failed",
      message: failure.message,
      retryable: false,
    };
    if (cancelled) this.observation.cancel({ error, failure: runtimeFailure });
    else this.observation.fail({ error, failure: runtimeFailure });
    await this.finish(cancelled ? "cancelled" : "error", { failure });
  }

  private async finish(
    status: Exclude<TraceRunManifest["status"], "running">,
    summary?: TraceRunManifest["summary"],
  ): Promise<void> {
    await this.runtime.completeRun(this.scope, status, summary);
  }
}
