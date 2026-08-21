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
  let closed = false;
  let resolveDone: ((termination: TuiTermination) => void) | null = null;

  return {
    start() {
      options.statusLine.setText(options.initialStatus);
      return new Promise<TuiTermination>((resolve) => {
        resolveDone = resolve;
        options.ui.start();
        // Starting commits all pre-start view updates as one deterministic initial frame.
        options.ui.renderNow(true);
      });
    },
    pause() {
      options.ui.stop();
    },
    resume() {
      options.ui.start();
      options.ui.requestRender(true);
    },
    shutdown(termination: TuiTermination = { kind: "completed" }) {
      if (closed) return;
      closed = true;
      options.release();
      options.ui.stop();
      resolveDone?.(termination);
    },
  };
}
