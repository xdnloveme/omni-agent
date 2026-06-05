import {
  Box,
  CombinedAutocompleteProvider,
  Container,
  Editor,
  Markdown,
  ProcessTerminal,
  Spacer,
  Text,
  TUI,
  matchesKey,
  Key,
  wrapTextWithAnsi,
  truncateToWidth,
  visibleWidth,
  type EditorTheme,
  type MarkdownTheme,
  type SelectListTheme,
} from "@mariozechner/pi-tui";
import chalk from "chalk";

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

export interface TuiSink {
  write(text: string): void;
  writeMarkdown(text: string): void;
  line(text?: string): void;
  spacer(): void;
  flush(): void;
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
  pause(): void;
  resume(): void;
  shutdown(): void;
}

export function createOmniTui(): OmniTui {
  const ui = new TUI(new ProcessTerminal());
  const messageContainer = new Container();
  const statusLine = new Text("", 0, 0);
  const editor = new Editor(ui, editorTheme);

  ui.addChild(messageContainer);
  ui.addChild(editor);
  ui.addChild(statusLine);
  ui.setFocus(editor);

  let closed = false;
  let resolveDone: (() => void) | null = null;
  let onSubmitCallback: ((input: string) => void | Promise<void>) | null = null;
  let onInterruptCallback: (() => boolean) | null = null;

  // Markdown streaming state
  let activeMarkdown: Markdown | null = null;
  let markdownBuffer = "";
  let markdownTimer: NodeJS.Timeout | null = null;
  let activeText: Text | null = null;
  let textBuffer = "";

  // Exit confirmation
  let exitPending = false;
  let exitTimer: NodeJS.Timeout | null = null;

  // Slash command completion
  function setCommands(commands: SlashCommand[]): void {
    const providerCommands = commands.map((cmd) => ({
      name: cmd.name,
      description: cmd.description,
    }));
    editor.setAutocompleteProvider(new CombinedAutocompleteProvider(providerCommands));
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
        activeMarkdown = new Markdown("", 0, 0, markdownTheme);
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
  };

  // Global input handler
  ui.addInputListener((data: string) => {
    const isCtrlC = matchesKey(data, Key.ctrl("c"));
    if (!isCtrlC) return undefined;

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
      void Promise.resolve(onSubmitCallback(input));
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
    ui.stop();
    resolveDone?.();
  }

  async function start(): Promise<void> {
    statusLine.setText(chalk.dim("omni-agent | Ctrl+C to exit"));
    ui.start();
    await new Promise<void>((resolve) => {
      resolveDone = resolve;
      const onSigterm = () => shutdown();
      process.once("SIGTERM", onSigterm);
    });
  }

  function pause() {
    ui.stop();
  }

  function resume() {
    ui.start();
    ui.requestRender(true);
  }

  return {
    start,
    sink,
    appendUserMessage,
    setStatus,
    setCommands,
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
