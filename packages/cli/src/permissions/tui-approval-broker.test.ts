import { describe, expect, it, vi } from "vitest";
import { TuiApprovalBroker } from "./tui-approval-broker";
import type { OmniTui } from "../interaction/tui/tui";

const request = {
  agentId: "coding",
  toolCallId: "call-1",
  toolIdentity: "builtin-coding:bash",
  toolName: "bash",
  risk: "execute" as const,
  presentation: { title: "Run shell command", detail: "pnpm test", reason: "executes code" },
  canAllowAlways: true,
};

function tui(value: string | null) {
  return {
    setStatus: vi.fn(),
    select: vi.fn(async () =>
      value === null ? ({ kind: "escape" } as const) : ({ kind: "selected", value } as const),
    ),
  } as unknown as OmniTui;
}

describe("TuiApprovalBroker", () => {
  it("offers persistent approval only when eligible", async () => {
    const interactive = tui("allow_always");
    await expect(new TuiApprovalBroker(interactive).request(request)).resolves.toBe("allow_always");
    expect(interactive.select).toHaveBeenCalledWith(
      expect.objectContaining({
        items: expect.arrayContaining([
          expect.objectContaining({
            value: "allow_always",
            label: "Always approve routine bash operations",
          }),
        ]),
      }),
      undefined,
    );

    const highRisk = tui("deny");
    await new TuiApprovalBroker(highRisk).request({ ...request, canAllowAlways: false });
    const options = vi.mocked(highRisk.select).mock.calls[0]![0];
    expect(options.items.some((item) => item.value === "allow_always")).toBe(false);
  });

  it("maps cancellation to denial", async () => {
    await expect(new TuiApprovalBroker(tui(null)).request(request)).resolves.toBe("deny");
  });

  it.each(["abort", "shutdown"] as const)("propagates %s as AbortError", async (kind) => {
    const interactive = {
      setStatus: vi.fn(),
      select: vi.fn(async () => ({ kind, error: new DOMException("aborted", "AbortError") })),
    } as unknown as OmniTui;
    await expect(new TuiApprovalBroker(interactive).request(request)).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});
