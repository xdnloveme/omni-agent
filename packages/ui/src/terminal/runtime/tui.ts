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
  hyperlink,
} from "@earendil-works/pi-tui";
import chalk from "chalk";
import { createClipboardCopy } from "./clipboard";
import { disclosureUrl } from "../components/disclosure-message";
import { RunMessage } from "../components/run-message";
import type {
  RunPresentationViewModel,
  SessionHistoryViewModel,
} from "../presentation/view-models";
import type { OmniTui, SlashCommand, TuiOptions, TuiSink, TuiTermination } from "./contracts";
import { createTuiInteractionController } from "./interaction-controller";
import { createTuiLifecycleController } from "./lifecycle-controller";
import { wrapTerminalText } from "./text-layout";
import { editorTheme, markdownTheme } from "./themes";

export type {
  OmniTui,
  SlashCommand,
  TuiMultiSelectResult,
  TuiOptions,
  TuiSink,
  TuiTermination,
  TuiTextInputOptions,
  TuiTextInputResult,
} from "./contracts";

const DISCLOSURE_TICK_MS = 1_000;

export function createOmniTui(options: TuiOptions): OmniTui {
  const internalLinks = new Map<string, () => void>();
  const terminal = new ProcessTerminal();
  const ui = new TuiAltScreen(terminal, true, undefined, {
    copySelection: createClipboardCopy(),
    openUrl(url) {
      if (url.startsWith("omni-agent://disclosure/")) {
        const targetId = decodeURIComponent(url.slice("omni-agent://disclosure/".length));
        for (const message of runMessages.values()) {
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

  let onSubmitCallback: ((input: string) => void | Promise<void>) | null = null;
  let onInterruptCallback: (() => boolean) | null = null;

  let activeText: Text | null = null;
  let textBuffer = "";
  const runMessages = new Map<string, RunMessage>();
  const runningDisclosures = new Set<string>();
  const runDisclosureIds = new Map<string, Set<string>>();
  let disclosureTimer: NodeJS.Timeout | null = null;
  let activityLoader: Loader | null = null;
  const historyRunIds = new Set<string>();
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

  const sink: TuiSink = {
    renderRun(viewModel) {
      syncRunDisclosureTicker(viewModel);
      const existing = runMessages.get(viewModel.id);
      if (existing) {
        existing.update(viewModel);
        ui.requestRender(true);
        return;
      }
      sink.line();
      const message = new RunMessage(viewModel, markdownTheme, disclosureUrl(viewModel.id));
      runMessages.set(viewModel.id, message);
      messageBody.addChild(message);
      ui.requestRender(true);
    },
    write(text: string) {
      if (!activeText) {
        activeText = new Text("", 0, 0);
        messageBody.addChild(activeText);
      }
      textBuffer += text;
      activeText.setText(wrapTerminalText(textBuffer, ui.terminal.columns));
      ui.requestRender();
    },
    line(text?: string) {
      if (activeText) {
        if (text) textBuffer += text;
        activeText.setText(wrapTerminalText(textBuffer, ui.terminal.columns));
        activeText = null;
        textBuffer = "";
        ui.requestRender();
        return;
      }
      // Standalone line
      const wrappedLines = wrapTerminalText(text ?? "", ui.terminal.columns).split("\n");
      for (const wrappedLine of wrappedLines) {
        messageBody.addChild(new Text(wrappedLine, 0, 0));
      }
      ui.requestRender();
    },
    spacer() {
      messageBody.addChild(new Spacer(1));
      activeText = null;
      textBuffer = "";
      ui.requestRender();
    },
  };

  function syncRunDisclosureTicker(viewModel: RunPresentationViewModel): void {
    const previousIds = runDisclosureIds.get(viewModel.id) ?? new Set<string>();
    for (const id of previousIds) runningDisclosures.delete(id);
    const currentIds = new Set<string>();
    for (const node of viewModel.processNodes) {
      if (node.kind !== "disclosure" || node.disclosure.state !== "running") continue;
      currentIds.add(node.disclosure.id);
      runningDisclosures.add(node.disclosure.id);
    }
    runDisclosureIds.set(viewModel.id, currentIds);
    syncDisclosureTimer();
  }

  function syncDisclosureTimer(): void {
    if (runningDisclosures.size > 0 && !disclosureTimer) {
      disclosureTimer = setInterval(() => ui.requestRender(true), DISCLOSURE_TICK_MS);
      return;
    }
    if (runningDisclosures.size === 0 && disclosureTimer) {
      clearInterval(disclosureTimer);
      disclosureTimer = null;
    }
  }

  const interactions = createTuiInteractionController({
    ui,
    editor,
    messageBody,
    internalLinks,
    line: () => sink.line(),
  });
  const lifecycle = createTuiLifecycleController({
    ui,
    statusLine,
    initialStatus: chalk.dim("omni-agent | Ctrl+C to exit"),
    release() {
      if (exitTimer) clearTimeout(exitTimer);
      if (disclosureTimer) clearInterval(disclosureTimer);
      stopActivity();
      internalLinks.clear();
      runMessages.clear();
      runDisclosureIds.clear();
      runningDisclosures.clear();
      onInterruptCallback?.();
      interactions.shutdown();
    },
  });

  // Global input handler
  ui.addInputListener((data: string) => {
    const isCtrlC = matchesKey(data, Key.ctrl("c"));
    if (!isCtrlC) {
      if (matchesKey(data, Key.escape) && interactions.escape()) {
        return { consume: true };
      }
      return undefined;
    }

    if (interactions.abort(onInterruptCallback)) {
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
      lifecycle.shutdown({ kind: "user_interrupt" });
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
    const previousRunIds = new Set(historyRunIds);
    historyRunIds.clear();
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
      const id = entry.run.id;
      let message = runMessages.get(id);
      if (message) message.update(entry.run);
      else {
        message = new RunMessage(entry.run, markdownTheme, disclosureUrl(id));
        runMessages.set(id, message);
      }
      historyRunIds.add(id);
      previousRunIds.delete(id);
      historyBody.addChild(message);
      historyBody.addChild(new Spacer(1));
    }

    for (const id of previousRunIds) runMessages.delete(id);
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
    for (const id of historyRunIds) runMessages.delete(id);
    historyRunIds.clear();
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

  return {
    start: lifecycle.start,
    sink,
    appendUserMessage,
    setSessionHistory,
    clearSessionHistory,
    setStatus,
    startActivity,
    setActivity,
    stopActivity,
    setCommands,
    select: interactions.select,
    multiSelect: interactions.multiSelect,
    textInput: interactions.textInput,
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
    pause: lifecycle.pause,
    resume: lifecycle.resume,
    shutdown: lifecycle.shutdown,
  };
}
