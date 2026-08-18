import {
  Box,
  CombinedAutocompleteProvider,
  Container,
  Editor,
  Loader,
  ProcessTerminal,
  ScrollView,
  Spacer,
  Text,
  TuiAltScreen,
  VStack,
  matchesKey,
  Key,
  wrapTextWithAnsi,
  truncateToWidth,
  visibleWidth,
  hyperlink,
  type EditorTheme,
  type MarkdownTheme,
  type SelectListTheme,
} from "@earendil-works/pi-tui";
import chalk from "chalk";
import {
  createAbortError,
  type CommandSelectionOptions,
  type CommandSelectionResult,
} from "@omni-agent/core";
import { InlineSelect } from "./inline-select";
import { InlineMultiSelect, type MultiSelectOptions } from "./inline-multi-select";
import { InlineTextInput, type InlineTextInputOptions } from "./inline-text-input";
import { createClipboardCopy } from "./clipboard";
import { MarkdownMessage } from "./markdown-message";
import { DisclosureMessage, disclosureUrl } from "./disclosure-message";
import type {
  DisclosureViewModel,
  RunMetricsViewModel,
  SessionHistoryViewModel,
} from "../../presentation/view-models";

const selectListTheme: SelectListTheme = {
  selectedPrefix: (text) => chalk.bold(chalk.blue(`> ${text}`)),
  selectedText: (text) => chalk.bold(chalk.blue(text)),
  description: (text) => chalk.dim(text),
  scrollInfo: (text) => chalk.dim(text),
  noMatch: (text) => chalk.dim(text),
};

const editorTheme: EditorTheme = {
  borderColor: (text) => chalk.dim(text),
  selectList: selectListTheme,
};

const markdownTheme: MarkdownTheme = {
  heading: (text) => chalk.bold(chalk.cyan(text)),
  link: (text) => chalk.underline(chalk.blue(text)),
  linkUrl: (text) => chalk.dim(text),
  code: (text) => chalk.yellow(text),
  codeBlock: (text) => chalk.gray(text),
  codeBlockBorder: (text) => chalk.dim(text),
  quote: (text) => chalk.italic(chalk.gray(text)),
  quoteBorder: (text) => chalk.dim(text),
  hr: (text) => chalk.dim(text),
  listBullet: (text) => chalk.cyan(text),
  bold: (text) => chalk.bold(text),
  italic: (text) => chalk.italic(text),
  strikethrough: (text) => chalk.strikethrough(text),
  underline: (text) => chalk.underline(text),
  codeBlockIndent: "  ",
};

const MARKDOWN_THROTTLE_MS = 50;
const DISCLOSURE_TICK_MS = 1_000;
export interface TuiSink {
  write(text: string): void;
  writeMarkdown(text: string): void;
  line(text?: string): void;
  spacer(): void;
  flush(): void;
  disclosure(viewModel: DisclosureViewModel): void;
  metrics(viewModel: RunMetricsViewModel): void;
}

export interface SlashCommand {
  name: string;
  description: string;
}

export type TuiTermination =
  | { readonly kind: "completed" }
  | { readonly kind: "user_interrupt" }
  | { readonly kind: "signal"; readonly signal: "SIGTERM" };

export interface OmniTui {
  start(): Promise<TuiTermination>;
  sink: TuiSink;
  appendUserMessage(text: string): void;
  setSessionHistory(
    viewModel: SessionHistoryViewModel,
    onLoadEarlier?: () => void | Promise<void>,
  ): void;
  clearSessionHistory(): void;
  setStatus(text: string): void;
  startActivity(text: string): void;
  setActivity(text: string): void;
  stopActivity(): void;
  setCommands(commands: SlashCommand[]): void;
  onSubmit: (input: string) => void | Promise<void>;
  onInterrupt: (() => boolean) | null;
  select(options: CommandSelectionOptions, signal?: AbortSignal): Promise<CommandSelectionResult>;
  multiSelect(options: MultiSelectOptions, signal?: AbortSignal): Promise<TuiMultiSelectResult>;
  textInput(options: TuiTextInputOptions, signal?: AbortSignal): Promise<TuiTextInputResult>;
  pause(): void;
  resume(): void;
  shutdown(): void;
}

export type TuiMultiSelectResult =
  | { readonly kind: "selected"; readonly values: readonly string[] }
  | { readonly kind: "escape" }
  | { readonly kind: "abort"; readonly error: Error }
  | { readonly kind: "shutdown"; readonly error: Error };

export type TuiTextInputOptions = InlineTextInputOptions;

export type TuiTextInputResult =
  | { readonly kind: "submitted"; readonly text: string }
  | { readonly kind: "escape" }
  | { readonly kind: "abort"; readonly error: Error }
  | { readonly kind: "shutdown"; readonly error: Error };

export interface TuiOptions {
  readonly workspaceRoot: string;
}

export function createOmniTui(options: TuiOptions): OmniTui {
  const internalLinks = new Map<string, () => void>();
  const terminal = new ProcessTerminal();
  const ui = new TuiAltScreen(terminal, true, undefined, {
    copySelection: createClipboardCopy(),
    openUrl(url) {
      if (url.startsWith("omni-agent://disclosure/")) {
        const targetId = decodeURIComponent(url.slice("omni-agent://disclosure/".length));
        for (const message of disclosureMessages.values()) {
          if (!message.toggle(targetId)) continue;
          ui.requestRender(true);
          return;
        }
      }
      internalLinks.get(url)?.();
    },
  });
  const historyBody = new Container();
  const messageBody = new Container();
  const activityContainer = new VStack();
  const messageContainer = new VStack([historyBody, messageBody, activityContainer]);
  const statusLine = new Text("", 0, 0);
  const editor = new Editor(ui, editorTheme);
  const transcript = new ScrollView(messageContainer, {
    follow: "end",
    primary: true,
    scrollbar: "auto",
  });

  ui.setLayoutRoot(
    new VStack([
      { component: transcript, basis: 0, grow: 1, minSize: 1 },
      { component: editor, basis: "auto", shrink: 0 },
      { component: statusLine, basis: 1, shrink: 0 },
    ]),
  );
  ui.setFocus(editor);

  let closed = false;
  let resolveDone: ((termination: TuiTermination) => void) | null = null;
  let sigtermListener: (() => void) | null = null;
  let onSubmitCallback: ((input: string) => void | Promise<void>) | null = null;
  let onInterruptCallback: (() => boolean) | null = null;
  let activeControl: {
    abort(error: Error): void;
    shutdown(error: Error): void;
    escape(): void;
  } | null = null;

  // Markdown streaming state
  let activeMarkdown: MarkdownMessage | null = null;
  let markdownBuffer = "";
  let markdownTimer: NodeJS.Timeout | null = null;
  let activeText: Text | null = null;
  let textBuffer = "";
  const disclosureMessages = new Map<string, DisclosureMessage>();
  const runningDisclosures = new Set<string>();
  let disclosureTimer: NodeJS.Timeout | null = null;
  let activityLoader: Loader | null = null;
  const historyDisclosureIds = new Set<string>();
  const historyLoadUrl = "omni-agent://history/load-earlier";

  // Exit confirmation
  let exitPending = false;
  let exitTimer: NodeJS.Timeout | null = null;

  // Slash command completion
  function setCommands(commands: SlashCommand[]): void {
    const providerCommands = commands.map((cmd) => ({
      name: cmd.name,
      description: cmd.description,
    }));
    editor.setAutocompleteProvider(
      new CombinedAutocompleteProvider(providerCommands, options.workspaceRoot),
    );
  }

  editor.setAutocompleteMaxVisible(10);

  function hardWrap(text: string): string {
    const terminalWidth = Math.max(20, ui.terminal.columns || 80);
    const safeWidth = Math.max(10, terminalWidth - 2);
    const wrappedLines: string[] = [];
    for (const sourceLine of text.split("\n")) {
      const lines = wrapTextWithAnsi(sourceLine, safeWidth);
      if (lines.length === 0) {
        wrappedLines.push("");
        continue;
      }
      for (const line of lines) {
        if (visibleWidth(line) <= safeWidth) {
          wrappedLines.push(line);
        } else {
          wrappedLines.push(truncateToWidth(line, safeWidth, ""));
        }
      }
    }
    return wrappedLines.join("\n");
  }

  function flushMarkdown() {
    if (!activeMarkdown) return;
    if (markdownTimer) {
      clearTimeout(markdownTimer);
      markdownTimer = null;
    }
    activeMarkdown.setText(markdownBuffer);
    ui.requestRender();
  }

  function scheduleMarkdownRender() {
    if (!activeMarkdown || markdownTimer) return;
    markdownTimer = setTimeout(() => {
      markdownTimer = null;
      if (!activeMarkdown) return;
      activeMarkdown.setText(markdownBuffer);
      ui.requestRender();
    }, MARKDOWN_THROTTLE_MS);
  }

  const sink: TuiSink = {
    write(text: string) {
      if (!activeText) {
        activeText = new Text("", 0, 0);
        messageBody.addChild(activeText);
      }
      textBuffer += text;
      activeText.setText(hardWrap(textBuffer));
      ui.requestRender();
    },
    writeMarkdown(text: string) {
      if (!activeMarkdown) {
        activeMarkdown = new MarkdownMessage("", markdownTheme);
        messageBody.addChild(activeMarkdown);
      }
      markdownBuffer += text;
      scheduleMarkdownRender();
    },
    line(text?: string) {
      if (activeMarkdown) {
        if (text) markdownBuffer += text;
        flushMarkdown();
        activeMarkdown = null;
        markdownBuffer = "";
        ui.requestRender();
        return;
      }
      if (activeText) {
        if (text) textBuffer += text;
        activeText.setText(hardWrap(textBuffer));
        activeText = null;
        textBuffer = "";
        ui.requestRender();
        return;
      }
      // Standalone line
      const wrappedLines = hardWrap(text ?? "").split("\n");
      for (const wrappedLine of wrappedLines) {
        messageBody.addChild(new Text(wrappedLine, 0, 0));
      }
      ui.requestRender();
    },
    spacer() {
      if (activeMarkdown) flushMarkdown();
      messageBody.addChild(new Spacer(1));
      activeText = null;
      textBuffer = "";
      activeMarkdown = null;
      markdownBuffer = "";
      ui.requestRender();
    },
    flush() {
      flushMarkdown();
    },
    disclosure(viewModel: DisclosureViewModel) {
      updateDisclosureTicker(viewModel);
      const existing = disclosureMessages.get(viewModel.id);
      if (existing) {
        existing.update(viewModel);
        ui.requestRender(true);
        return;
      }
      sink.line();
      const linkUrl = disclosureUrl(viewModel.id);
      const message = new DisclosureMessage(viewModel, linkUrl);
      disclosureMessages.set(viewModel.id, message);
      messageBody.addChild(message);
      ui.requestRender();
    },
    metrics(viewModel: RunMetricsViewModel) {
      const width = ui.terminal.columns || 80;
      const text =
        width >= 90 ? viewModel.full : width >= 55 ? viewModel.compact : viewModel.minimal;
      sink.line(
        viewModel.usagePercent > 80
          ? chalk.red(text)
          : viewModel.usagePercent >= 50
            ? chalk.yellow(text)
            : chalk.dim(text),
      );
    },
  };

  function updateDisclosureTicker(viewModel: DisclosureViewModel): void {
    if (viewModel.state === "running") runningDisclosures.add(viewModel.id);
    else runningDisclosures.delete(viewModel.id);

    if (runningDisclosures.size > 0 && !disclosureTimer) {
      disclosureTimer = setInterval(() => ui.requestRender(true), DISCLOSURE_TICK_MS);
      return;
    }
    if (runningDisclosures.size === 0 && disclosureTimer) {
      clearInterval(disclosureTimer);
      disclosureTimer = null;
    }
  }

  // Global input handler
  ui.addInputListener((data: string) => {
    const isCtrlC = matchesKey(data, Key.ctrl("c"));
    if (!isCtrlC) {
      if (activeControl && matchesKey(data, Key.escape)) {
        activeControl.escape();
        return { consume: true };
      }
      return undefined;
    }

    if (activeControl) {
      if (onInterruptCallback?.()) return { consume: true };
      activeControl.abort(createAbortError());
      return { consume: true };
    }

    // If editor has text, clear it
    const hasInput = editor.getText().length > 0;
    if (hasInput) {
      editor.setText("");
      ui.requestRender();
      return { consume: true };
    }

    // Try interrupt callback
    if (onInterruptCallback?.()) {
      return { consume: true };
    }

    // Exit confirmation
    if (exitPending) {
      shutdown({ kind: "user_interrupt" });
    } else {
      exitPending = true;
      statusLine.setText(chalk.dim("[press Ctrl+C again to exit]"));
      ui.requestRender();
      exitTimer = setTimeout(() => {
        exitPending = false;
        statusLine.setText(chalk.dim("omni-agent | Ctrl+C to exit"));
        ui.requestRender();
      }, 2000);
    }
    return { consume: true };
  });

  editor.onSubmit = (raw: string) => {
    if (!raw.trim()) return;
    if (onSubmitCallback) {
      void Promise.resolve(onSubmitCallback(raw)).catch((error: unknown) => {
        if (error instanceof Error && error.name === "AbortError") return;
        sink.line(
          chalk.red(`Input failed: ${error instanceof Error ? error.message : String(error)}`),
        );
        sink.spacer();
      });
    }
  };

  function appendUserMessageTo(target: Container, text: string) {
    target.addChild(new Spacer(1));
    const frame = new Box(1, 1, (segment) => chalk.white.bgAnsi256(237)(segment));
    frame.addChild(new Text(text, 0, 0));
    target.addChild(frame);
    target.addChild(new Spacer(1));
  }

  function appendUserMessage(text: string) {
    appendUserMessageTo(messageBody, text);
    ui.requestRender();
  }

  function setSessionHistory(
    viewModel: SessionHistoryViewModel,
    onLoadEarlier?: () => void | Promise<void>,
  ) {
    const width = transcript.getContentWidth(ui.terminal.columns || 80);
    const previousHeight = historyBody.render(width).length;
    const previousScrollTop = transcript.scrollTop;
    const wasFollowingEnd = transcript.isFollowingEnd;
    const previousDisclosureIds = new Set(historyDisclosureIds);
    historyDisclosureIds.clear();
    historyBody.clear();
    internalLinks.delete(historyLoadUrl);

    if (viewModel.header) {
      historyBody.addChild(new Text(chalk.bold(viewModel.header.title), 0, 0));
      historyBody.addChild(new Text(chalk.dim(viewModel.header.subtitle), 0, 0));
      historyBody.addChild(new Spacer(1));
    }

    if (viewModel.loadEarlierLabel && onLoadEarlier) {
      historyBody.addChild(
        new Text(hyperlink(chalk.dim(viewModel.loadEarlierLabel), historyLoadUrl), 0, 0),
      );
      historyBody.addChild(new Spacer(1));
      internalLinks.set(historyLoadUrl, () => {
        void Promise.resolve(onLoadEarlier()).catch((error: unknown) => {
          sink.line(
            chalk.red(
              `Unable to load earlier history: ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
          sink.spacer();
        });
      });
    }

    for (const entry of viewModel.entries) {
      if (entry.type === "user") {
        appendUserMessageTo(historyBody, entry.text);
        continue;
      }
      if (entry.type === "assistant") {
        historyBody.addChild(new MarkdownMessage(entry.markdown, markdownTheme));
        historyBody.addChild(new Spacer(1));
        continue;
      }
      const id = entry.disclosure.id;
      let message = disclosureMessages.get(id);
      if (message) message.update(entry.disclosure);
      else {
        message = new DisclosureMessage(entry.disclosure, disclosureUrl(id));
        disclosureMessages.set(id, message);
      }
      historyDisclosureIds.add(id);
      previousDisclosureIds.delete(id);
      historyBody.addChild(message);
      historyBody.addChild(new Spacer(1));
    }

    for (const id of previousDisclosureIds) disclosureMessages.delete(id);
    historyBody.addChild(new Text(chalk.dim(viewModel.resumedDivider), 0, 0));
    historyBody.addChild(new Spacer(1));

    const addedHeight = historyBody.render(width).length - previousHeight;
    if (!wasFollowingEnd && previousHeight > 0 && addedHeight !== 0) {
      ui.renderNow(true);
      transcript.scrollTo(previousScrollTop + addedHeight);
    }
    ui.requestRender(true);
  }

  function clearSessionHistory() {
    internalLinks.delete(historyLoadUrl);
    for (const id of historyDisclosureIds) disclosureMessages.delete(id);
    historyDisclosureIds.clear();
    historyBody.clear();
    ui.requestRender(true);
  }

  function setStatus(text: string) {
    statusLine.setText(text);
    ui.requestRender();
  }

  function startActivity(text: string) {
    if (activityLoader) {
      activityLoader.setMessage(text);
      ui.requestRender();
      return;
    }
    activityLoader = new Loader(ui, chalk.cyan, chalk.dim, text);
    activityContainer.addChild(activityLoader);
    activityLoader.start();
    ui.requestRender(true);
  }

  function setActivity(text: string) {
    if (!activityLoader) return;
    activityLoader.setMessage(text);
    ui.requestRender();
  }

  function stopActivity() {
    if (!activityLoader) return;
    activityLoader.stop();
    activityContainer.removeChild(activityLoader);
    activityLoader = null;
    ui.requestRender(true);
  }

  function shutdown(termination: TuiTermination = { kind: "completed" }) {
    if (closed) return;
    closed = true;
    if (exitTimer) clearTimeout(exitTimer);
    if (markdownTimer) clearTimeout(markdownTimer);
    if (disclosureTimer) clearInterval(disclosureTimer);
    stopActivity();
    internalLinks.clear();
    disclosureMessages.clear();
    runningDisclosures.clear();
    if (sigtermListener) {
      process.removeListener("SIGTERM", sigtermListener);
      sigtermListener = null;
    }
    onInterruptCallback?.();
    activeControl?.shutdown(createAbortError());
    ui.stop();
    resolveDone?.(termination);
  }

  async function start(): Promise<TuiTermination> {
    statusLine.setText(chalk.dim("omni-agent | Ctrl+C to exit"));
    return new Promise<TuiTermination>((resolve) => {
      resolveDone = resolve;
      sigtermListener = () => shutdown({ kind: "signal", signal: "SIGTERM" });
      process.once("SIGTERM", sigtermListener);
      ui.start();
      // Starting the TUI commits all pre-start view updates as one deterministic initial frame.
      ui.renderNow(true);
    });
  }

  function pause() {
    ui.stop();
  }

  function resume() {
    ui.start();
    ui.requestRender(true);
  }

  function select(
    options: CommandSelectionOptions,
    signal?: AbortSignal,
  ): Promise<CommandSelectionResult> {
    if (activeControl) return Promise.reject(new Error("A selection is already active"));
    if (signal?.aborted) {
      return Promise.resolve({ kind: "abort", error: createAbortError(signal) });
    }
    sink.line();
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
    sink.line();
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
    sink.line();
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
    start,
    sink,
    appendUserMessage,
    setSessionHistory,
    clearSessionHistory,
    setStatus,
    startActivity,
    setActivity,
    stopActivity,
    setCommands,
    select,
    multiSelect,
    textInput,
    set onSubmit(handler: (input: string) => void | Promise<void>) {
      onSubmitCallback = handler;
    },
    get onSubmit(): (input: string) => void | Promise<void> {
      return onSubmitCallback ?? (() => undefined);
    },
    set onInterrupt(handler: (() => boolean) | null) {
      onInterruptCallback = handler;
    },
    get onInterrupt(): (() => boolean) | null {
      return onInterruptCallback;
    },
    pause,
    resume,
    shutdown,
  };
}
