import type { StreamCallbacks } from "@omni-agent/core";
import type { OmniTui } from "../interaction/tui/tui";
import { CompressionEventPresenter } from "./compression-event-presenter";
import { RunMetricsPresenter } from "./run-metrics-presenter";
import { SkillStreamPresenter } from "./skill-stream-presenter";
import { ToolBatchPresenter } from "./tool-batch-presenter";

export class StreamPresentationRouter {
  private readonly tools = new ToolBatchPresenter();
  private readonly compression = new CompressionEventPresenter();
  private readonly metrics = new RunMetricsPresenter();

  constructor(
    private readonly tui: OmniTui,
    private readonly skills?: SkillStreamPresenter,
  ) {}

  cancelPending(): void {
    for (const viewModel of [...this.tools.cancelPending(), ...this.compression.cancelPending()]) {
      this.tui.sink.disclosure(viewModel);
    }
  }

  callbacks(): StreamCallbacks {
    return {
      onTextChunk: (delta) => this.tui.sink.writeMarkdown(delta),
      onModelContextPrepared: (manifest) => this.metrics.recordContext(manifest),
      onModelCacheReport: (report) => this.metrics.recordCache(report),
      onContextProgress: (event) => {
        this.tui.sink.disclosure(this.compression.present(event));
        this.tui.setStatus(
          event.type === "compression_started" ? "compressing context..." : "thinking...",
        );
      },
      onToolBatchStart: ({ batch }) => {
        const viewModel = this.tools.start({
          ...batch,
          members: batch.members.filter((member) => !this.skills?.claimsTool(member.toolName)),
        });
        if (viewModel) this.tui.sink.disclosure(viewModel);
      },
      onToolStart: ({ toolName, toolCallId, input, preview, batch }) => {
        if (this.skills?.claimsTool(toolName)) return;
        const viewModel = this.tools.toolStarted(toolName, toolCallId, input, preview, batch);
        if (viewModel) this.tui.sink.disclosure(viewModel);
        this.tui.setStatus(`running: ${toolName}...`);
      },
      onToolEnd: ({ toolName, toolCallId, result, durationMs, batch }) => {
        if (this.skills?.claimsTool(toolName)) return;
        const viewModel = this.tools.toolCompleted(toolCallId, result, durationMs, batch);
        if (viewModel) this.tui.sink.disclosure(viewModel);
        this.tui.setStatus("thinking...");
      },
      onToolBatchEnd: ({ batchId, modelCallId, durationMs }) => {
        const viewModel = this.tools.complete(batchId, modelCallId, durationMs);
        if (viewModel === undefined) return;
        if (viewModel) this.tui.sink.disclosure(viewModel);
        this.tui.sink.spacer();
        this.tui.setStatus("thinking...");
      },
      onExtensionEvent: (event) => {
        this.skills?.present(event);
      },
      onDone: (usage) => {
        this.tui.sink.line();
        if (usage) this.tui.sink.metrics(this.metrics.present(usage));
        this.tui.sink.spacer();
      },
      onError: (error) => {
        this.tui.sink.line();
        this.tui.sink.line(`Error: ${error}`);
        this.tui.sink.spacer();
      },
    };
  }
}
