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
  persistentApprovals: [
    {
      kind: "tool_routine" as const,
      label: "Always approve routine bash operations",
    },
  ],
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
    const routineOptions = vi.mocked(interactive.select).mock.calls[0]![0];
    expect(routineOptions.items.map((item) => item.value)).toEqual([
      "allow_always",
      "allow_once",
      "deny",
    ]);
    expect(routineOptions.items[0]?.label).toBe("Always approve routine bash operations");

    const highRisk = tui("deny");
    await new TuiApprovalBroker(highRisk).request({ ...request, persistentApprovals: undefined });
    const options = vi.mocked(highRisk.select).mock.calls[0]![0];
    expect(options.items.map((item) => item.value)).toEqual(["allow_once", "deny"]);
    expect(options.items.some((item) => item.value === "allow_always")).toBe(false);
  });

  it("maps cancellation to denial", async () => {
    await expect(new TuiApprovalBroker(tui(null)).request(request)).resolves.toBe("deny");
  });

  it("renders an assessor-provided executable approval label", async () => {
    const interactive = tui("allow_always");
    await new TuiApprovalBroker(interactive).request({
      ...request,
      risk: "unknown",
      persistentApprovals: [
        {
          kind: "bash_executable",
          label: "Always trust executable: mycli",
        },
      ],
    });
    expect(vi.mocked(interactive.select).mock.calls[0]![0].items[0]).toMatchObject({
      value: "allow_always",
      label: "Always trust executable: mycli",
    });
  });

  it("renders one approval for all missing command executables", async () => {
    const interactive = tui("allow_always");
    await new TuiApprovalBroker(interactive).request({
      ...request,
      risk: "unknown",
      persistentApprovals: [
        { kind: "bash_executable", label: "Always trust executable: mycli" },
        { kind: "bash_executable", label: "Always trust executable: uploader" },
      ],
    });
    expect(vi.mocked(interactive.select).mock.calls[0]![0].items[0]).toMatchObject({
      value: "allow_always",
      label: "Always trust listed executables",
      description: expect.stringContaining("uploader"),
    });
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
