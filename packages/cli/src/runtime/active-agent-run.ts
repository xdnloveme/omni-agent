export type ActiveAgentRunState = "idle" | "running" | "closing" | "closed";

export class ActiveAgentRun {
  private currentState: ActiveAgentRunState = "idle";
  private activeController: AbortController | undefined;
  private activePromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;

  get state(): ActiveAgentRunState {
    return this.currentState;
  }

  run(operation: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.currentState === "closed" || this.currentState === "closing") {
      return Promise.reject(new ActiveAgentRunError("active_run_closed"));
    }
    if (this.activePromise) {
      return Promise.reject(new ActiveAgentRunError("active_run_busy"));
    }

    const controller = new AbortController();
    this.currentState = "running";
    this.activeController = controller;
    const operationPromise = Promise.resolve().then(() => operation(controller.signal));
    const settlement = operationPromise.then(
      () => undefined,
      () => undefined,
    );
    this.activePromise = settlement;
    void settlement
      .finally(() => {
        if (this.activePromise !== settlement) return;
        this.activePromise = undefined;
        this.activeController = undefined;
        if (this.currentState === "running") this.currentState = "idle";
      })
      .catch(() => undefined);
    return operationPromise;
  }

  interrupt(): boolean {
    const controller = this.activeController;
    if (!controller || controller.signal.aborted) return false;
    controller.abort();
    return true;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.currentState === "closed") return Promise.resolve();
    this.currentState = "closing";
    this.activeController?.abort();
    const active = this.activePromise;
    this.closePromise = (active ?? Promise.resolve()).finally(() => {
      this.activePromise = undefined;
      this.activeController = undefined;
      this.currentState = "closed";
    });
    return this.closePromise;
  }
}

export class ActiveAgentRunError extends Error {
  constructor(readonly code: "active_run_busy" | "active_run_closed") {
    super(code === "active_run_busy" ? "An Agent run is already active" : "Agent runs are closed");
    this.name = "ActiveAgentRunError";
  }
}
