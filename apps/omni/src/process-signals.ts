import type { HostTermination } from "@omni-agent/cli";

export interface ProcessSignalRegistration {
  dispose(): void;
}

type ProcessSignal = "SIGINT" | "SIGTERM";

interface ProcessSignalSupervisorOptions {
  readonly gracefulShutdownMs: number;
  readonly terminate: (termination: HostTermination) => void;
  readonly forceExit: (signal: ProcessSignal) => void;
}

export class ProcessSignalSupervisor {
  readonly #options: ProcessSignalSupervisorOptions;
  #pendingSignal: ProcessSignal | null = null;
  #deadline: ReturnType<typeof setTimeout> | null = null;

  constructor(options: ProcessSignalSupervisorOptions) {
    this.#options = options;
  }

  handle(signal: ProcessSignal, termination: HostTermination): void {
    if (this.#pendingSignal) {
      this.#forceExit();
      return;
    }
    this.#pendingSignal = signal;
    this.#deadline = setTimeout(() => this.#forceExit(), this.#options.gracefulShutdownMs);
    this.#deadline.unref?.();
    this.#options.terminate(termination);
  }

  dispose(): void {
    if (this.#deadline) clearTimeout(this.#deadline);
    this.#deadline = null;
    this.#pendingSignal = null;
  }

  #forceExit(): void {
    const signal = this.#pendingSignal;
    if (!signal) return;
    this.dispose();
    this.#options.forceExit(signal);
  }
}

export interface ProcessTerminationPort {
  readonly signal: AbortSignal;
  readonly current: HostTermination | null;
  subscribe(listener: (termination: HostTermination) => void): () => void;
}

export class ProcessTerminationController implements ProcessTerminationPort {
  readonly #abortController = new AbortController();
  readonly #listeners = new Set<(termination: HostTermination) => void>();
  #current: HostTermination | null = null;

  get signal(): AbortSignal {
    return this.#abortController.signal;
  }

  get current(): HostTermination | null {
    return this.#current;
  }

  terminate(termination: HostTermination): void {
    if (this.#current) return;
    this.#current = termination;
    this.#abortController.abort();
    for (const listener of this.#listeners) listener(termination);
    this.#listeners.clear();
  }

  subscribe(listener: (termination: HostTermination) => void): () => void {
    if (this.#current) {
      listener(this.#current);
      return () => undefined;
    }
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

export function registerProcessSignals(
  terminate: (termination: HostTermination) => void,
  gracefulShutdownMs = 5_000,
): ProcessSignalRegistration {
  const supervisor = new ProcessSignalSupervisor({
    gracefulShutdownMs,
    terminate,
    forceExit(signal) {
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
      process.kill(process.pid, signal);
    },
  });
  const onInterrupt = () => supervisor.handle("SIGINT", { kind: "user_interrupt" });
  const onTerminate = () => supervisor.handle("SIGTERM", { kind: "signal", signal: "SIGTERM" });
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  return {
    dispose() {
      supervisor.dispose();
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
    },
  };
}
