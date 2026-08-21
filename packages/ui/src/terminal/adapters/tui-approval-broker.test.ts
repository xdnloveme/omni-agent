import { describe, expect, it, vi } from "vitest";
import type {
  InteractionRequest,
  InteractionResponse,
  InteractionSurfacePort,
} from "@omni-agent/core";
import { ScriptedInteractionSurface } from "@omni-agent/core/testing";
import { TuiApprovalBroker } from "./tui-approval-broker";

const request = {
  agentId: "coding",
  toolCallId: "call-1",
  toolIdentity: "builtin-coding:bash",
  toolName: "bash",
  risk: "execute" as const,
  presentation: { title: "Run shell command", detail: "pnpm test", reason: "executes code" },
  persistentApprovals: [
    { kind: "tool_routine" as const, label: "Always approve routine bash operations" },
  ],
};

function surface(value: string | null) {
  const scripted = new ScriptedInteractionSurface();
  scripted.enqueue((interaction): InteractionResponse =>
    value === null
      ? { requestId: interaction.requestId, kind: "dismissed", values: {} }
      : {
          requestId: interaction.requestId,
          kind: "completed",
          values: { approval: { type: "single", optionId: value } },
        },
  );
  return scripted;
}

function approvalOptions(interaction: InteractionRequest) {
  const field = interaction.fields[0];
  if (field?.type !== "single") throw new Error("Expected an approval single-select field");
  return field.options;
}

describe("TuiApprovalBroker", () => {
  it("offers persistent approval only when eligible", async () => {
    const interactive = surface("allow_always");
    await expect(new TuiApprovalBroker(interactive).request(request)).resolves.toBe("allow_always");
    const options = approvalOptions(interactive.requests()[0]!);
    expect(options.map((item) => item.id)).toEqual(["allow_always", "allow_once", "deny"]);
    expect(options[0]?.label).toBe("Always approve routine bash operations");
    expect(interactive.requests()[0]).toMatchObject({
      title: "Permission required",
      detail: expect.stringContaining("Run shell command"),
      message: expect.stringContaining("executes code"),
      tone: "warning",
      status: "awaiting permission: bash",
      completionStatus: "running: bash...",
    });

    const ordinary = surface("deny");
    await new TuiApprovalBroker(ordinary).request({ ...request, persistentApprovals: undefined });
    expect(approvalOptions(ordinary.requests()[0]!).map((item) => item.id)).toEqual([
      "allow_once",
      "deny",
    ]);
  });

  it("maps cancellation to denial", async () => {
    await expect(new TuiApprovalBroker(surface(null)).request(request)).resolves.toBe("deny");
  });

  it("renders assessor-provided executable approval labels", async () => {
    const interactive = surface("allow_always");
    await new TuiApprovalBroker(interactive).request({
      ...request,
      risk: "unknown",
      persistentApprovals: [
        { kind: "bash_executable", label: "Always trust executable: mycli" },
        { kind: "bash_executable", label: "Always trust executable: uploader" },
      ],
    });
    expect(approvalOptions(interactive.requests()[0]!)[0]).toMatchObject({
      id: "allow_always",
      label: "Always trust listed executables",
      description: expect.stringContaining("uploader"),
    });
  });

  it("propagates AbortError", async () => {
    const interactive: InteractionSurfacePort = {
      request: vi.fn(async () => {
        throw new DOMException("aborted", "AbortError");
      }),
    };
    await expect(new TuiApprovalBroker(interactive).request(request)).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});
