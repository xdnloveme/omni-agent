import { describe, expect, it } from "vitest";
import type { InteractionSurfacePort } from "@omni-agent/core";
import { InteractionAbortError } from "@omni-agent/core";
import { ScriptedInteractionSurface } from "@omni-agent/core/testing";
import type { OmniTui } from "../runtime/tui";
import { TuiCommandInteractionAdapter } from "./command-interaction-adapter";

function tui(): OmniTui {
  return {
    pause() {},
    resume() {},
    sink: { line() {}, spacer() {} },
  } as unknown as OmniTui;
}

describe("TuiCommandInteractionAdapter", () => {
  it("maps completed and dismissed responses", async () => {
    const completed = new ScriptedInteractionSurface();
    completed.enqueue((request) => ({
      requestId: request.requestId,
      kind: "completed",
      values: { selection: { type: "single", optionId: "one" } },
    }));
    await expect(
      new TuiCommandInteractionAdapter(tui(), completed).select({
        title: "Choose",
        items: [{ value: "one", label: "One" }],
      }),
    ).resolves.toEqual({ kind: "selected", value: "one" });

    const dismissed = new ScriptedInteractionSurface();
    dismissed.enqueue((request) => ({
      requestId: request.requestId,
      kind: "dismissed",
      values: {},
    }));
    await expect(
      new TuiCommandInteractionAdapter(tui(), dismissed).select({ title: "Choose", items: [] }),
    ).resolves.toEqual({ kind: "escape" });
  });

  it("maps AbortError without swallowing ordinary failures", async () => {
    const aborted: InteractionSurfacePort = {
      async request() {
        throw new DOMException("aborted", "AbortError");
      },
    };
    await expect(
      new TuiCommandInteractionAdapter(tui(), aborted).select({ title: "Choose", items: [] }),
    ).resolves.toMatchObject({ kind: "abort", error: { name: "AbortError" } });
  });

  it("preserves shutdown termination", async () => {
    const shutdown: InteractionSurfacePort = {
      async request() {
        throw new InteractionAbortError("shutdown");
      },
    };
    await expect(
      new TuiCommandInteractionAdapter(tui(), shutdown).select({ title: "Choose", items: [] }),
    ).resolves.toMatchObject({ kind: "shutdown", error: { name: "AbortError" } });
  });
});
