import type { Text, TuiAltScreen } from "@earendil-works/pi-tui";
import type { TuiTermination } from "./contracts";

interface LifecycleOptions {
  readonly ui: TuiAltScreen;
  readonly statusLine: Text;
  readonly initialStatus: string;
  readonly release: () => void;
}

export interface TuiLifecycleController {
  start(): Promise<TuiTermination>;
  pause(): void;
  resume(): void;
  shutdown(termination?: TuiTermination): void;
}

export function createTuiLifecycleController(options: LifecycleOptions): TuiLifecycleController {
  type LifecycleState = "created" | "running" | "closed";

  let state: LifecycleState = "created";
  let closedWith: TuiTermination | null = null;
  let completion: Promise<TuiTermination> | null = null;
  let resolveDone: ((termination: TuiTermination) => void) | null = null;

  return {
    start() {
      if (state === "closed") return Promise.resolve(closedWith!);
      if (completion) return completion;

      state = "running";
      options.statusLine.setText(options.initialStatus);
      completion = new Promise<TuiTermination>((resolve) => {
        resolveDone = resolve;
        options.ui.start();
        // Starting commits all pre-start view updates as one deterministic initial frame.
        options.ui.renderNow(true);
      });
      return completion;
    },
    pause() {
      if (state !== "running") return;
      options.ui.stop();
    },
    resume() {
      if (state !== "running") return;
      options.ui.start();
      options.ui.requestRender(true);
    },
    shutdown(termination: TuiTermination = { kind: "completed" }) {
      if (state === "closed") return;
      const wasRunning = state === "running";
      state = "closed";
      closedWith = termination;
      options.release();
      if (wasRunning) options.ui.stop();
      resolveDone?.(termination);
    },
  };
}
