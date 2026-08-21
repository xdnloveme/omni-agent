import type { TextDeltaEvent } from "@omni-agent/core";
import { describe, expect, it } from "vitest";
import { RunPresentationModel } from "./run-presentation-model";

function textDelta(modelCallId: string, segment: number, delta: string): TextDeltaEvent {
  return {
    type: "text_delta",
    modelCallId,
    textSegmentId: `${modelCallId}:text:${segment}`,
    delta,
  };
}

describe("RunPresentationModel", () => {
  it("preserves text segments and projects only the explicitly final call", () => {
    const model = new RunPresentationModel("run", 100);
    model.appendText(textDelta("call-1", 0, "before"));
    model.appendPlain("tool output");
    model.appendText(textDelta("call-1", 1, "after"));
    model.appendText(textDelta("call-2", 0, "final "));
    model.appendText(textDelta("call-2", 0, "answer"));

    model.markFinal("call-2");
    const projection = model.project();

    expect(projection.finalNode).toMatchObject({
      modelCallId: "call-2",
      markdown: "final answer",
    });
    expect(projection.processNodes).toEqual([
      expect.objectContaining({ kind: "text", modelCallId: "call-1", markdown: "before" }),
      expect.objectContaining({ kind: "plain", text: "tool output" }),
      expect.objectContaining({ kind: "text", modelCallId: "call-1", markdown: "after" }),
    ]);
  });

  it("rejects a final identity without a matching text node", () => {
    const model = new RunPresentationModel("run");
    expect(() => model.markFinal("missing")).toThrow(
      "Final response has no text node for model call missing",
    );
  });

  it("updates disclosures in place without changing their order", () => {
    const model = new RunPresentationModel("run");
    const disclosure = {
      id: "tool",
      title: "Tool",
      state: "running" as const,
      tone: "neutral" as const,
      details: () => ["running"],
      initiallyExpanded: true,
    };
    model.upsertDisclosure(disclosure);
    model.appendPlain("after");
    model.upsertDisclosure({ ...disclosure, state: "completed", details: () => ["done"] });

    expect(model.project().processNodes).toEqual([
      expect.objectContaining({
        kind: "disclosure",
        disclosure: expect.objectContaining({ id: "tool", state: "completed" }),
      }),
      expect.objectContaining({ kind: "plain", text: "after" }),
    ]);
  });

  it("keeps metrics outside process nodes", () => {
    const model = new RunPresentationModel("run");
    const metrics = { full: "full", compact: "compact", minimal: "minimal", usagePercent: 20 };
    model.setMetrics(metrics);
    model.complete(200);

    expect(model.project()).toMatchObject({ state: "completed", metrics, completedAt: 200 });
    expect(model.project().processNodes).toEqual([]);
  });
});
