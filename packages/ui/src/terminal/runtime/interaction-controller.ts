import { Spacer, type Container, type Editor, type TuiAltScreen } from "@earendil-works/pi-tui";
import {
  createAbortError,
  type CommandSelectionOptions,
  type CommandSelectionResult,
} from "@omni-agent/core";
import { InlineMultiSelect, type MultiSelectOptions } from "../components/inline-multi-select";
import { InlineSelect } from "../components/inline-select";
import { InlineTextInput } from "../components/inline-text-input";
import type { TuiMultiSelectResult, TuiTextInputOptions, TuiTextInputResult } from "./contracts";

interface ActiveControl {
  abort(error: Error): void;
  shutdown(error: Error): void;
  escape(): void;
}

interface InteractionControllerOptions {
  readonly ui: TuiAltScreen;
  readonly editor: Editor;
  readonly messageBody: Container;
  readonly internalLinks: Map<string, () => void>;
  readonly line: () => void;
}

export interface TuiInteractionController {
  readonly active: boolean;
  abort(onInterrupt: (() => boolean) | null): boolean;
  escape(): boolean;
  shutdown(): void;
  select(options: CommandSelectionOptions, signal?: AbortSignal): Promise<CommandSelectionResult>;
  multiSelect(options: MultiSelectOptions, signal?: AbortSignal): Promise<TuiMultiSelectResult>;
  textInput(options: TuiTextInputOptions, signal?: AbortSignal): Promise<TuiTextInputResult>;
}

export function createTuiInteractionController(
  dependencies: InteractionControllerOptions,
): TuiInteractionController {
  const { ui, editor, messageBody, internalLinks, line } = dependencies;
  let activeControl: ActiveControl | null = null;

  function select(
    options: CommandSelectionOptions,
    signal?: AbortSignal,
  ): Promise<CommandSelectionResult> {
    if (activeControl) return Promise.reject(new Error("A selection is already active"));
    if (signal?.aborted) {
      return Promise.resolve({ kind: "abort", error: createAbortError(signal) });
    }
    line();
    const selectionId = crypto.randomUUID();
    const linkForValue = (value: string) =>
      `omni-agent://select/${selectionId}/${encodeURIComponent(value)}`;
    const selection = new InlineSelect(options, linkForValue);
    messageBody.addChild(selection);
    messageBody.addChild(new Spacer(1));
    return runActiveControl<CommandSelectionResult>({
      signal,
      abort: (error) => ({ kind: "abort", error }),
      shutdown: (error) => ({ kind: "shutdown", error }),
      escape: () => ({ kind: "escape" }),
      start(finish) {
        selection.onSelect = (value) => finish({ kind: "selected", value });
        selection.onCancel = () => finish({ kind: "escape" });
        for (const item of options.items) {
          internalLinks.set(linkForValue(item.value), () =>
            finish({ kind: "selected", value: item.value }),
          );
        }
        ui.setFocus(selection);
        ui.requestRender(true);
      },
      cleanup(result) {
        selection.resolve(result.kind === "selected" ? result.value : undefined);
        for (const item of options.items) internalLinks.delete(linkForValue(item.value));
        restoreEditorFocus();
      },
    });
  }

  function multiSelect(
    options: MultiSelectOptions,
    signal?: AbortSignal,
  ): Promise<TuiMultiSelectResult> {
    if (activeControl) return Promise.reject(new Error("A selection is already active"));
    if (signal?.aborted) return Promise.resolve({ kind: "abort", error: createAbortError(signal) });
    line();
    const selection = new InlineMultiSelect(options);
    messageBody.addChild(selection);
    messageBody.addChild(new Spacer(1));
    return runActiveControl<TuiMultiSelectResult>({
      signal,
      abort: (error) => ({ kind: "abort", error }),
      shutdown: (error) => ({ kind: "shutdown", error }),
      escape: () => ({ kind: "escape" }),
      start(finish) {
        selection.onSubmit = (values) => finish({ kind: "selected", values });
        selection.onCancel = () => finish({ kind: "escape" });
        ui.setFocus(selection);
        ui.requestRender(true);
      },
      cleanup(result) {
        selection.complete(result.kind === "selected" ? result.values : undefined);
        restoreEditorFocus();
      },
    });
  }

  function textInput(
    options: TuiTextInputOptions,
    signal?: AbortSignal,
  ): Promise<TuiTextInputResult> {
    if (activeControl) return Promise.reject(new Error("An interaction is already active"));
    if (signal?.aborted) return Promise.resolve({ kind: "abort", error: createAbortError(signal) });
    line();
    const input = new InlineTextInput(options);
    messageBody.addChild(input);
    messageBody.addChild(new Spacer(1));
    return runActiveControl<TuiTextInputResult>({
      signal,
      abort: (error) => ({ kind: "abort", error }),
      shutdown: (error) => ({ kind: "shutdown", error }),
      escape: () => ({ kind: "escape" }),
      start(finish) {
        input.onSubmit = (text) => finish({ kind: "submitted", text });
        input.onCancel = () => finish({ kind: "escape" });
        ui.setFocus(input);
        ui.requestRender(true);
      },
      cleanup(result) {
        input.complete(result.kind === "submitted" ? result.text : undefined);
        restoreEditorFocus();
      },
    });
  }

  function restoreEditorFocus(): void {
    ui.setFocus(editor);
    ui.requestRender(true);
  }

  function runActiveControl<TResult>(options: {
    readonly signal?: AbortSignal;
    readonly abort: (error: Error) => TResult;
    readonly shutdown: (error: Error) => TResult;
    readonly escape: () => TResult;
    readonly start: (finish: (result: TResult) => void) => void;
    readonly cleanup: (result: TResult) => void;
  }): Promise<TResult> {
    return new Promise<TResult>((resolve, reject) => {
      let settled = false;
      const onAbort = () => finish(options.abort(createAbortError(options.signal)));
      const finish = (result: TResult) => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener("abort", onAbort);
        activeControl = null;
        try {
          options.cleanup(result);
          resolve(result);
        } catch (error) {
          reject(error);
        }
      };
      activeControl = {
        abort: (error) => finish(options.abort(error)),
        shutdown: (error) => finish(options.shutdown(error)),
        escape: () => finish(options.escape()),
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        options.start(finish);
      } catch (error) {
        options.signal?.removeEventListener("abort", onAbort);
        activeControl = null;
        settled = true;
        reject(error);
        return;
      }
      if (options.signal?.aborted) onAbort();
    });
  }

  return {
    get active() {
      return activeControl !== null;
    },
    abort(onInterrupt) {
      if (!activeControl) return false;
      if (!onInterrupt?.()) activeControl.abort(createAbortError());
      return true;
    },
    escape() {
      if (!activeControl) return false;
      activeControl.escape();
      return true;
    },
    shutdown() {
      activeControl?.shutdown(createAbortError());
    },
    select,
    multiSelect,
    textInput,
  };
}
