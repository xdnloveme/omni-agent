import type { StreamCallbacks } from "@omni-agent/core";
import type { OmniTui } from "../interaction/tui/tui";
import { CompressionEventPresenter } from "./compression-event-presenter";
import { RunMetricsPresenter } from "./run-metrics-presenter";
import { RunPresentationModel } from "./run-presentation-model";
import { SkillStreamPresenter } from "./skill-stream-presenter";
import { ThinkingPresenter } from "./thinking-presenter";
import { ToolBatchPresenter } from "./tool-batch-presenter";
import type { DisclosureViewModel } from "./view-models";

const THINKING_RENDER_THROTTLE_MS = 50;
const RUN_TEXT_RENDER_THROTTLE_MS = 50;

export class StreamPresentationRouter {
  private readonly tools = new ToolBatchPresenter();
  private readonly thinking = new ThinkingPresenter();
  private readonly compression = new CompressionEventPresenter();
  private readonly metrics = new RunMetricsPresenter();
  private readonly run: RunPresentationModel;
  private readonly displayedThinkingIds = new Set<string>();
  private readonly pendingThinkingViews = new Map<string, DisclosureViewModel>();
  private thinkingRenderTimer: NodeJS.Timeout | null = null;
  private runRenderTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly tui: OmniTui,
    private readonly skills?: SkillStreamPresenter,
  ) {
    this.run = new RunPresentationModel(`run:${crypto.randomUUID()}`);
    this.publish();
  }

  cancelPending(): void {
    this.clearRunRenderTimer();
    this.clearPendingThinkingViews();
    const pending = this.cancelPendingPresenters();
    if (!this.run.isRunning) return;
    for (const viewModel of pending) this.run.upsertDisclosure(viewModel);
    this.run.cancel();
    this.publish();
  }

  callbacks(): StreamCallbacks {
    return {
      onTextChunk: (event) => {
        this.tui.setActivity("Responding…");
        this.run.appendText(event);
        this.scheduleRunRender();
      },
      onFinalResponse: ({ modelCallId }) => {
        this.run.markFinal(modelCallId);
        this.publish();
      },
      onThinkingStart: ({ modelCallId, contentIndex }) => {
        this.thinking.start(modelCallId, contentIndex);
        this.tui.setActivity("Thinking…");
      },
      onThinkingChunk: ({ modelCallId, contentIndex, delta }) => {
        const viewModel = this.thinking.append(modelCallId, contentIndex, delta);
        if (viewModel) this.presentThinking(viewModel);
        this.tui.setActivity("Thinking…");
      },
      onThinkingEnd: ({ modelCallId, contentIndex, content }) => {
        const viewModel = this.thinking.complete(modelCallId, contentIndex, content);
        if (viewModel) this.completeThinking(viewModel);
        this.tui.setActivity("Working…");
      },
      onModelContextPrepared: (manifest) => this.metrics.recordContext(manifest),
      onModelCacheReport: (report) => this.metrics.recordCache(report),
      onContextProgress: (event) => {
        this.presentDisclosure(this.compression.present(event));
        this.tui.setStatus(
          event.type === "compression_started" ? "compressing context..." : "thinking...",
        );
        this.tui.setActivity(
          event.type === "compression_started" ? "Preparing context…" : "Thinking…",
        );
      },
      onToolBatchStart: ({ batch }) => {
        const viewModel = this.tools.start({
          ...batch,
          members: batch.members.filter((member) => !this.skills?.claimsTool(member.toolName)),
        });
        if (viewModel) this.presentDisclosure(viewModel);
      },
      onToolStart: ({ toolName, toolCallId, input, preview, batch }) => {
        if (this.skills?.claimsTool(toolName)) return;
        const viewModel = this.tools.toolStarted(toolName, toolCallId, input, preview, batch);
        if (viewModel) this.presentDisclosure(viewModel);
        this.tui.setStatus("running tool calls...");
        this.tui.setActivity("Running tool calls…");
      },
      onToolEnd: ({ toolName, toolCallId, result, durationMs, batch }) => {
        if (this.skills?.claimsTool(toolName)) return;
        const viewModel = this.tools.toolCompleted(toolCallId, result, durationMs, batch);
        if (viewModel) this.presentDisclosure(viewModel);
        this.tui.setStatus("thinking...");
        this.tui.setActivity("Working…");
      },
      onToolBatchEnd: ({ batchId, modelCallId, durationMs }) => {
        const viewModel = this.tools.complete(batchId, modelCallId, durationMs);
        if (viewModel === undefined) return;
        if (viewModel) this.run.upsertDisclosure(viewModel);
        this.run.appendSpacer();
        this.publish();
        this.tui.setStatus("thinking...");
        this.tui.setActivity("Thinking…");
      },
      onExtensionEvent: (event) => {
        const presented = this.skills?.present(event, {
          line: (text = "") => {
            this.run.appendPlain(text);
          },
          spacer: () => {
            this.run.appendSpacer();
          },
        });
        if (presented) this.publish();
      },
      onDone: (usage) => {
        if (usage) this.run.setMetrics(this.metrics.present(usage));
        this.run.complete();
        this.publish();
      },
      onError: (failure) => {
        this.clearPendingThinkingViews();
        for (const viewModel of this.cancelPendingPresenters()) {
          this.run.upsertDisclosure(viewModel);
        }
        this.run.fail(failure.message);
        this.publish();
      },
    };
  }

  private presentThinking(viewModel: DisclosureViewModel): void {
    if (!this.displayedThinkingIds.has(viewModel.id)) {
      this.displayedThinkingIds.add(viewModel.id);
      this.presentDisclosure(viewModel);
      return;
    }
    this.pendingThinkingViews.set(viewModel.id, viewModel);
    if (this.thinkingRenderTimer) return;
    this.thinkingRenderTimer = setTimeout(
      () => this.flushPendingThinkingViews(),
      THINKING_RENDER_THROTTLE_MS,
    );
  }

  private completeThinking(viewModel: DisclosureViewModel): void {
    this.pendingThinkingViews.delete(viewModel.id);
    this.displayedThinkingIds.delete(viewModel.id);
    if (this.pendingThinkingViews.size === 0 && this.thinkingRenderTimer) {
      clearTimeout(this.thinkingRenderTimer);
      this.thinkingRenderTimer = null;
    }
    this.presentDisclosure(viewModel);
  }

  private flushPendingThinkingViews(): void {
    this.thinkingRenderTimer = null;
    const views = [...this.pendingThinkingViews.values()];
    this.pendingThinkingViews.clear();
    for (const viewModel of views) this.presentDisclosure(viewModel);
  }

  private clearPendingThinkingViews(): void {
    if (this.thinkingRenderTimer) clearTimeout(this.thinkingRenderTimer);
    this.thinkingRenderTimer = null;
    this.pendingThinkingViews.clear();
    this.displayedThinkingIds.clear();
  }

  private cancelPendingPresenters(): readonly DisclosureViewModel[] {
    return [
      ...this.thinking.cancelPending(),
      ...this.tools.cancelPending(),
      ...this.compression.cancelPending(),
    ];
  }

  private presentDisclosure(viewModel: DisclosureViewModel): void {
    this.run.upsertDisclosure(viewModel);
    this.publish();
  }

  private publish(): void {
    this.clearRunRenderTimer();
    this.tui.sink.renderRun(this.run.project());
  }

  private scheduleRunRender(): void {
    if (this.runRenderTimer) return;
    this.runRenderTimer = setTimeout(() => {
      this.runRenderTimer = null;
      this.tui.sink.renderRun(this.run.project());
    }, RUN_TEXT_RENDER_THROTTLE_MS);
  }

  private clearRunRenderTimer(): void {
    if (this.runRenderTimer) clearTimeout(this.runRenderTimer);
    this.runRenderTimer = null;
  }
}
