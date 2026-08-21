import chalk from "chalk";
import type { SkillSource, TranscriptMessage } from "@omni-agent/core";
import { TuiCommandInteractionAdapter } from "./adapters/command-interaction-adapter";
import { TuiApprovalBroker } from "./adapters/tui-approval-broker";
import { TuiInteractionSurface } from "./adapters/tui-interaction-surface";
import { renderSkillReadEnd, renderSkillReadStart } from "./presentation/skill-renderer";
import { SkillStreamPresenter } from "./presentation/skill-stream-presenter";
import { StreamPresentationRouter } from "./presentation/stream-presentation-router";
import { TranscriptHistoryPresenter } from "./presentation/transcript-history-presenter";
import { createOmniTui } from "./runtime/tui";

interface SkillReadInput {
  readonly skillName: string;
  readonly status: "loaded" | "cached" | "failed";
  readonly source?: SkillSource;
  readonly filePath?: string;
  readonly tokenEstimate?: number;
  readonly durationMs?: number;
  readonly error?: string;
  readonly mode?: "inferred" | "explicit";
}

export function createAgentConsole(options: { readonly workspaceRoot: string }) {
  const tui = createOmniTui(options);
  const interactionSurface = new TuiInteractionSurface(tui);
  const approvalBroker = new TuiApprovalBroker(interactionSurface);
  const commandInteraction = new TuiCommandInteractionAdapter(tui, interactionSurface);

  return {
    interactionSurface,
    approvalBroker,
    commandInteraction,
    start: () => tui.start(),
    terminate: (termination: Parameters<typeof tui.shutdown>[0]) => tui.shutdown(termination),
    dispose() {
      interactionSurface.dispose();
      tui.shutdown();
    },
    bindHandlers(handlers: {
      onSubmit(input: string): void | Promise<void>;
      onInterrupt(): boolean;
    }) {
      tui.onSubmit = handlers.onSubmit;
      tui.onInterrupt = handlers.onInterrupt;
    },
    setCommandCatalog(commands: readonly { name: string; description: string }[]) {
      tui.setCommands([...commands]);
    },
    showWelcome(agent: { id: string; displayName?: string }) {
      tui.sink.line(chalk.bold(`omni-agent · ${agent.displayName ?? agent.id}`));
      tui.sink.line(
        chalk.dim("Type your request below. Session history is preserved across restarts."),
      );
      tui.sink.spacer();
    },
    showSessionHistory(
      messages: readonly TranscriptMessage[],
      historyOptions: {
        initialTurns: number;
        agent: { id: string; displayName?: string };
      },
    ) {
      const presenter = new TranscriptHistoryPresenter(historyOptions.initialTurns);
      let visibleTurns = historyOptions.initialTurns;
      const render = () => {
        const viewModel = {
          ...presenter.present(messages, visibleTurns),
          header: {
            title: `omni-agent · ${historyOptions.agent.displayName ?? historyOptions.agent.id}`,
            subtitle: "Session restored. Earlier conversation is shown below.",
          },
        };
        tui.setSessionHistory(
          viewModel,
          viewModel.hiddenTurnCount > 0
            ? () => {
                visibleTurns += historyOptions.initialTurns;
                render();
              }
            : undefined,
        );
      };
      render();
    },
    clearSessionHistory: () => tui.clearSessionHistory(),
    appendUserMessage: (text: string) => tui.appendUserMessage(text),
    writeNotice(text: string, tone: "neutral" | "success" | "warning" | "error" = "neutral") {
      const style =
        tone === "success"
          ? chalk.green
          : tone === "warning"
            ? chalk.yellow
            : tone === "error"
              ? chalk.red
              : (value: string) => value;
      tui.sink.line(style(text));
      tui.sink.spacer();
    },
    setStatus(status: { text: string; tone: "neutral" | "active" | "warning" | "error" }) {
      const style =
        status.tone === "active"
          ? chalk.cyan
          : status.tone === "warning"
            ? chalk.yellow
            : status.tone === "error"
              ? chalk.red
              : chalk.dim;
      tui.setStatus(style(status.text));
    },
    setActivity(text: string | null) {
      if (text === null) tui.stopActivity();
      else tui.startActivity(text);
    },
    presentSkillRead(input: SkillReadInput) {
      renderSkillReadStart(tui.sink, input.skillName);
      renderSkillReadEnd(tui.sink, input, input.mode);
    },
    createRunPresentation(presentationOptions: { skills: boolean } = { skills: false }) {
      const router = new StreamPresentationRouter(
        tui,
        presentationOptions.skills ? new SkillStreamPresenter(tui) : undefined,
      );
      return {
        callbacks: () => router.callbacks(),
        cancelPending: () => router.cancelPending(),
      };
    },
  };
}
