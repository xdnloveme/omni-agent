import { describe, expect, it, vi } from "vitest";
import type { CommandSelectionOptions, InteractionRequest } from "@omni-agent/core";
import type { OmniTui } from "../runtime/tui";
import { TuiInteractionSurface } from "./tui-interaction-surface";

function request(fields: InteractionRequest["fields"]): InteractionRequest {
  return {
    requestId: crypto.randomUUID(),
    title: "Clarification",
    fields,
    completion: {
      type: "explicit",
      actions: [
        { id: "submit", label: "Submit" },
        { id: "skip", label: "Skip" },
      ],
    },
  };
}

describe("TuiInteractionSurface", () => {
  it("collects single, multiple, Other and text fields in order", async () => {
    let firstSelection: CommandSelectionOptions | undefined;
    const tui = {
      select: vi.fn().mockImplementationOnce(async (options) => {
        firstSelection = options;
        return { kind: "selected", value: "react" };
      }),
      multiSelect: vi.fn(async (options) => ({
        kind: "selected",
        values: [
          "search",
          options.items.find((item: { label: string }) => item.label.startsWith("Other"))!.value,
        ],
      })),
      textInput: vi
        .fn()
        .mockResolvedValueOnce({ kind: "submitted", text: "Export" })
        .mockResolvedValueOnce({ kind: "submitted", text: "Preserve the API" }),
      setStatus: vi.fn(),
    } as unknown as OmniTui;
    const surface = new TuiInteractionSurface(tui);
    const response = await surface.request({
      ...request([
        {
          type: "single",
          id: "framework",
          label: "Framework",
          options: [
            { id: "react", label: "React" },
            { id: "vue", label: "Vue" },
          ],
        },
        {
          type: "multiple",
          id: "features",
          label: "Features",
          allowOther: true,
          options: [
            { id: "search", label: "Search" },
            { id: "filter", label: "Filter" },
          ],
        },
        { type: "text", id: "notes", label: "Notes" },
      ]),
      detail: "Choose implementation constraints",
      message: "This choice changes the generated code",
      tone: "warning",
      dismissLabel: "Skip",
      status: "awaiting clarification",
      completionStatus: "running",
      completion: { type: "on_complete" },
    });

    expect(response).toMatchObject({
      kind: "completed",
      values: {
        framework: { type: "single", optionId: "react" },
        features: { type: "multiple", optionIds: ["search"], otherText: "Export" },
        notes: { type: "text", text: "Preserve the API" },
      },
    });
    expect(firstSelection).toMatchObject({
      title: "Clarification",
      detail: expect.stringContaining("Framework"),
      message: "This choice changes the generated code",
      tone: "warning",
      dismissLabel: "Skip",
    });
    expect(tui.setStatus).toHaveBeenNthCalledWith(1, "awaiting clarification");
    expect(tui.setStatus).toHaveBeenLastCalledWith("running");
    expect(tui.select).toHaveBeenCalledTimes(1);
  });

  it("opens custom input directly after selecting Other and completes without an action menu", async () => {
    const tui = {
      select: vi.fn(async (options: CommandSelectionOptions) => ({
        kind: "selected",
        value: options.items.find((item) => item.label.startsWith("Other"))!.value,
      })),
      textInput: vi.fn(async () => ({ kind: "submitted", text: "Use SolidJS" })),
      setStatus: vi.fn(),
    } as unknown as OmniTui;
    const surface = new TuiInteractionSurface(tui);

    await expect(
      surface.request({
        ...request([
          {
            type: "single",
            id: "framework",
            label: "Framework",
            allowOther: true,
            options: [
              { id: "react", label: "React" },
              { id: "vue", label: "Vue" },
            ],
          },
        ]),
        completion: { type: "on_complete" },
      }),
    ).resolves.toMatchObject({
      kind: "completed",
      values: { framework: { type: "single", otherText: "Use SolidJS" } },
    });
    expect(tui.select).toHaveBeenCalledTimes(1);
    expect(tui.textInput).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Framework — Custom answer",
        acceptsEmpty: false,
      }),
      expect.any(AbortSignal),
    );
  });

  it("dismisses on Escape", async () => {
    const tui = {
      select: vi.fn(async () => ({ kind: "escape" })),
    } as unknown as OmniTui;
    const surface = new TuiInteractionSurface(tui);
    await expect(
      surface.request(
        request([
          {
            type: "single",
            id: "choice",
            label: "Choice",
            options: [{ id: "a", label: "A" }],
          },
        ]),
      ),
    ).resolves.toMatchObject({ kind: "dismissed", values: {} });
  });

  it("rejects concurrent requests and aborts the active request on dispose", async () => {
    const tui = {
      textInput: vi.fn(
        async (_options, signal: AbortSignal) =>
          new Promise((resolve) => {
            signal.addEventListener(
              "abort",
              () => resolve({ kind: "abort", error: new DOMException("aborted", "AbortError") }),
              { once: true },
            );
          }),
      ),
    } as unknown as OmniTui;
    const surface = new TuiInteractionSurface(tui);
    const active = surface.request(request([{ type: "text", id: "notes", label: "Notes" }]));
    await expect(
      surface.request(request([{ type: "text", id: "other", label: "Other" }])),
    ).rejects.toMatchObject({ code: "interaction_busy" });
    surface.dispose();
    await expect(active).rejects.toMatchObject({ name: "AbortError" });
  });

  it("does not confuse a business option id with the internal Other value", async () => {
    const reservedLookingId = "__interaction_other__";
    const tui = {
      select: vi.fn(async () => ({ kind: "selected", value: reservedLookingId })),
      textInput: vi.fn(),
    } as unknown as OmniTui;
    const surface = new TuiInteractionSurface(tui);
    await expect(
      surface.request({
        requestId: "collision",
        title: "Choose",
        fields: [
          {
            type: "single",
            id: "choice",
            label: "Choice",
            allowOther: true,
            options: [
              { id: reservedLookingId, label: "Business option" },
              { id: "other", label: "Another option" },
            ],
          },
        ],
        completion: { type: "on_select", fieldId: "choice" },
      }),
    ).resolves.toMatchObject({
      values: { choice: { type: "single", optionId: reservedLookingId } },
    });
    expect(tui.textInput).not.toHaveBeenCalled();
  });

  it("preserves shutdown as a distinguishable AbortError", async () => {
    const tui = {
      select: vi.fn(async () => ({
        kind: "shutdown",
        error: new DOMException("shutdown", "AbortError"),
      })),
    } as unknown as OmniTui;
    const surface = new TuiInteractionSurface(tui);
    await expect(
      surface.request({
        requestId: "shutdown",
        title: "Choose",
        fields: [
          {
            type: "single",
            id: "choice",
            label: "Choice",
            options: [{ id: "one", label: "One" }],
          },
        ],
        completion: { type: "on_select", fieldId: "choice" },
      }),
    ).rejects.toMatchObject({ name: "AbortError", termination: "shutdown" });
  });
});
