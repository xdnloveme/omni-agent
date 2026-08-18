import type { TextDeltaEvent } from "@omni-agent/core";
import type {
  DisclosureViewModel,
  RunMetricsViewModel,
  RunPresentationNode,
  RunPresentationViewModel,
} from "./view-models";

type TextNode = Extract<RunPresentationNode, { kind: "text" }>;

export class RunPresentationModel {
  private readonly nodes: RunPresentationNode[] = [];
  private readonly textNodeIndex = new Map<string, number>();
  private readonly disclosureNodeIndex = new Map<string, number>();
  private sequence = 0;
  private finalModelCallId: string | undefined;
  private metrics: RunMetricsViewModel | undefined;
  private state: RunPresentationViewModel["state"] = "running";
  private completedAt: number | undefined;

  constructor(
    private readonly id: string,
    private readonly startedAt: number = Date.now(),
  ) {}

  get isRunning(): boolean {
    return this.state === "running";
  }

  appendText(event: TextDeltaEvent): void {
    this.assertRunning();
    const index = this.textNodeIndex.get(event.textSegmentId);
    if (index === undefined) {
      this.textNodeIndex.set(event.textSegmentId, this.nodes.length);
      this.nodes.push({
        id: this.nextNodeId("text"),
        kind: "text",
        modelCallId: event.modelCallId,
        textSegmentId: event.textSegmentId,
        markdown: event.delta,
      });
      return;
    }
    const node = this.nodes[index];
    if (node?.kind !== "text" || node.modelCallId !== event.modelCallId) {
      throw new Error(`Invalid text segment ${event.textSegmentId}`);
    }
    this.nodes[index] = { ...node, markdown: node.markdown + event.delta };
  }

  upsertDisclosure(disclosure: DisclosureViewModel): void {
    this.assertRunning();
    const index = this.disclosureNodeIndex.get(disclosure.id);
    if (index === undefined) {
      this.disclosureNodeIndex.set(disclosure.id, this.nodes.length);
      this.nodes.push({
        id: this.nextNodeId("disclosure"),
        kind: "disclosure",
        disclosure,
      });
      return;
    }
    const node = this.nodes[index];
    if (node?.kind !== "disclosure") {
      throw new Error(`Invalid disclosure node index for ${disclosure.id}`);
    }
    this.nodes[index] = { ...node, disclosure };
  }

  appendPlain(text: string): void {
    this.assertRunning();
    this.nodes.push({ id: this.nextNodeId("plain"), kind: "plain", text });
  }

  appendSpacer(): void {
    this.assertRunning();
    this.nodes.push({ id: this.nextNodeId("spacer"), kind: "spacer" });
  }

  markFinal(modelCallId: string): void {
    this.assertRunning();
    if (!this.nodes.some((node) => node.kind === "text" && node.modelCallId === modelCallId)) {
      throw new Error(`Final response has no text node for model call ${modelCallId}`);
    }
    if (this.finalModelCallId && this.finalModelCallId !== modelCallId) {
      throw new Error(`Run ${this.id} already has final response ${this.finalModelCallId}`);
    }
    this.finalModelCallId = modelCallId;
  }

  setMetrics(metrics: RunMetricsViewModel): void {
    this.metrics = metrics;
  }

  complete(completedAt: number = Date.now()): void {
    if (this.state !== "running") return;
    this.state = "completed";
    this.completedAt = completedAt;
  }

  fail(message: string, completedAt: number = Date.now()): void {
    if (this.state !== "running") return;
    this.appendPlain(`Error: ${message}`);
    this.state = "failed";
    this.completedAt = completedAt;
  }

  cancel(completedAt: number = Date.now()): void {
    if (this.state !== "running") return;
    this.state = "cancelled";
    this.completedAt = completedAt;
  }

  project(): RunPresentationViewModel {
    const finalNode = this.finalModelCallId ? this.finalTextNode(this.finalModelCallId) : undefined;
    const processNodes = finalNode
      ? this.nodes.filter(
          (node) => node.kind !== "text" || node.modelCallId !== this.finalModelCallId,
        )
      : [...this.nodes];
    return {
      id: this.id,
      processNodes,
      finalNode,
      metrics: this.metrics,
      state: this.state,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
    };
  }

  private finalTextNode(modelCallId: string): TextNode {
    const nodes = this.nodes.filter(
      (node): node is TextNode => node.kind === "text" && node.modelCallId === modelCallId,
    );
    const first = nodes[0];
    if (!first) {
      throw new Error(`Missing text node for model call ${modelCallId}`);
    }
    return { ...first, markdown: nodes.map((node) => node.markdown).join("") };
  }

  private nextNodeId(kind: RunPresentationNode["kind"]): string {
    return `${this.id}:${kind}:${this.sequence++}`;
  }

  private assertRunning(): void {
    if (this.state !== "running") throw new Error(`Run ${this.id} is already ${this.state}`);
  }
}
