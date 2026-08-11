import {
  Box,
  CombinedAutocompleteProvider,
  Container,
  Editor,
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
import { MarkdownMessage } from "./markdown-message";
import { ToolMessage, type ToolMessageResult } from "./tool-message";

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
const TOOL_RESULT_PREVIEW_MS = 1200;

export interface TuiSink {
  write(text: string): void;
  writeMarkdown(text: string): void;
  line(text?: string): void;
  spacer(): void;
  flush(): void;
  toolStart(toolName: string, toolCallId: string, inputPreview: string): void;
  toolEnd(toolCallId: string, result: ToolMessageResult, durationMs: number): void;
}

export interface SlashCommand {
  name: string;
  description: string;
}

export interface OmniTui {
  start(): Promise<void>;
  sink: TuiSink;
  appendUserMessage(text: string): void;
  setStatus(text: string): void;
  setCommands(commands: SlashCommand[]): void;
  onSubmit: (input: string) => void | Promise<void>;
  onInterrupt: (() => boolean) | null;
  select(options: CommandSelectionOptions, signal?: AbortSignal): Promise<CommandSelectionResult>;
  pause(): void;
  resume(): void;
  shutdown(): void;
}

export function createOmniTui(): OmniTui {
  const internalLinks = new Map<string, () => void>();
  const terminal = new ProcessTerminal();
  const ui = new TuiAltScreen(terminal, true, undefined, {
    openUrl(url) {
      internalLinks.get(url)?.();
    },
  });
  const messageContainer = new Container();
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
  let resolveDone: (() => void) | null = null;
  let sigtermListener: (() => void) | null = null;
  let onSubmitCallback: ((input: string) => void | Promise<void>) | null = null;
  let onInterruptCallback: (() => boolean) | null = null;
  let activeSelection: {
    finish(result: CommandSelectionResult): void;
  } | null = null;

  // Markdown streaming state
  let activeMarkdown: MarkdownMessage | null = null;
  let markdownBuffer = "";
  let markdownTimer: NodeJS.Timeout | null = null;
  let activeText: Text | null = null;
  let textBuffer = "";
  const toolMessages = new Map<string, ToolMessage>();
  const toolPreviewTimers = new Set<NodeJS.Timeout>();

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
      new CombinedAutocompleteProvider(providerCommands, process.cwd()),
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
        messageContainer.addChild(activeText);
      }
      textBuffer += text;
      activeText.setText(hardWrap(textBuffer));
      ui.requestRender();
    },
    writeMarkdown(text: string) {
      if (!activeMarkdown) {
        activeMarkdown = new MarkdownMessage("", markdownTheme);
        messageContainer.addChild(activeMarkdown);
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
        messageContainer.addChild(new Text(wrappedLine, 0, 0));
      }
      ui.requestRender();
    },
    spacer() {
      if (activeMarkdown) flushMarkdown();
      messageContainer.addChild(new Spacer(1));
      activeText = null;
      textBuffer = "";
      activeMarkdown = null;
      markdownBuffer = "";
      ui.requestRender();
    },
    flush() {
      flushMarkdown();
    },
    toolStart(toolName: string, toolCallId: string, inputPreview: string) {
      sink.line();
      const linkUrl = `omni-agent://tool/${encodeURIComponent(toolCallId)}`;
      const message = new ToolMessage(toolName, inputPreview, false, linkUrl);
      toolMessages.set(toolCallId, message);
      internalLinks.set(linkUrl, () => {
        message.toggleDetails();
        ui.requestRender(true);
      });
      messageContainer.addChild(message);
      ui.requestRender();
    },
    toolEnd(toolCallId: string, result: ToolMessageResult, durationMs: number) {
      const message = toolMessages.get(toolCallId);
      if (!message) return;
      message.finish(result, durationMs, true, true);
      ui.requestRender();
      const timer = setTimeout(() => {
        toolPreviewTimers.delete(timer);
        message.collapsePreview();
        ui.requestRender(true);
      }, TOOL_RESULT_PREVIEW_MS);
      toolPreviewTimers.add(timer);
    },
  };

  // Global input handler
  ui.addInputListener((data: string) => {
    const isCtrlC = matchesKey(data, Key.ctrl("c"));
    if (!isCtrlC) return undefined;

    if (activeSelection) {
      if (onInterruptCallback?.()) return { consume: true };
      activeSelection.finish({ kind: "abort", error: createAbortError() });
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
      shutdown();
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
    const input = raw.trim();
    if (!input) return;
    if (onSubmitCallback) {
      void Promise.resolve(onSubmitCallback(input)).catch((error: unknown) => {
        if (error instanceof Error && error.name === "AbortError") return;
        sink.line(
          chalk.red(`Input failed: ${error instanceof Error ? error.message : String(error)}`),
        );
        sink.spacer();
      });
    }
  };

  function appendUserMessage(text: string) {
    messageContainer.addChild(new Spacer(1));
    const frame = new Box(1, 1, (segment) => chalk.white.bgAnsi256(237)(segment));
    frame.addChild(new Text(text, 0, 0));
    messageContainer.addChild(frame);
    messageContainer.addChild(new Spacer(1));
    ui.requestRender();
  }

  function setStatus(text: string) {
    statusLine.setText(text);
    ui.requestRender();
  }

  function shutdown() {
    if (closed) return;
    closed = true;
    if (exitTimer) clearTimeout(exitTimer);
    if (markdownTimer) clearTimeout(markdownTimer);
    for (const timer of toolPreviewTimers) clearTimeout(timer);
    toolPreviewTimers.clear();
    internalLinks.clear();
    if (sigtermListener) {
      process.removeListener("SIGTERM", sigtermListener);
      sigtermListener = null;
    }
    onInterruptCallback?.();
    activeSelection?.finish({ kind: "shutdown", error: createAbortError() });
    ui.stop();
    resolveDone?.();
  }

  async function start(): Promise<void> {
    statusLine.setText(chalk.dim("omni-agent | Ctrl+C to exit"));
    ui.start();
    await new Promise<void>((resolve) => {
      resolveDone = resolve;
      sigtermListener = () => shutdown();
      process.once("SIGTERM", sigtermListener);
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
    if (activeSelection) return Promise.reject(new Error("A selection is already active"));
    if (signal?.aborted) {
      return Promise.resolve({ kind: "abort", error: createAbortError(signal) });
    }
    return new Promise<CommandSelectionResult>((resolve) => {
      sink.line();
      const selectionId = crypto.randomUUID();
      const linkForValue = (value: string) =>
        `omni-agent://select/${selectionId}/${encodeURIComponent(value)}`;
      const selection = new InlineSelect(options, linkForValue);
      messageContainer.addChild(selection);
      messageContainer.addChild(new Spacer(1));
      let settled = false;
      const onAbort = () => finish({ kind: "abort", error: createAbortError(signal) });
      const finish = (result: CommandSelectionResult) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        selection.resolve(result.kind === "selected" ? result.value : undefined);
        activeSelection = null;
        for (const item of options.items) internalLinks.delete(linkForValue(item.value));
        ui.setFocus(editor);
        ui.requestRender(true);
        resolve(result);
      };
      selection.onSelect = (value) => finish({ kind: "selected", value });
      selection.onCancel = () => finish({ kind: "escape" });
      activeSelection = { finish };
      for (const item of options.items) {
        internalLinks.set(linkForValue(item.value), () =>
          finish({ kind: "selected", value: item.value }),
        );
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      ui.setFocus(selection);
      ui.requestRender(true);
    });
  }

  return {
    start,
    sink,
    appendUserMessage,
    setStatus,
    setCommands,
    select,
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
