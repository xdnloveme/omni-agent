import { describe, expect, it, vi } from "vitest";
import type { AgentApplication } from "@omni-agent/app";
import type { CommandContext } from "@omni-agent/core";
import { createPermissionsCommand } from "./permissions";

const text = {
  heading: (value: string) => value,
  accent: (value: string) => value,
  muted: (value: string) => value,
  success: (value: string) => value,
  warning: (value: string) => value,
  error: (value: string) => value,
};

describe("permissions command", () => {
  it("lists and revokes a persistent approval by grant ID", async () => {
    const revokePersistentApproval = vi.fn(async () => undefined);
    const app = {
      agentId: "coding",
      getPermissionMode: vi.fn(async () => "standard" as const),
      listPersistentApprovals: vi.fn(async () => [
        {
          id: "grant-id",
          toolIdentity: "builtin-coding:bash",
          toolName: "bash",
          scopeKey:
            "bash:executable:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          scopeKind: "bash_executable" as const,
          label: "Always trust executable: mycli",
        },
      ]),
      revokePersistentApproval,
    } as unknown as AgentApplication;
    const select = vi.fn(async (options: { items: Array<{ value: string }> }) => ({
      kind: "selected" as const,
      value: options.items.find((item) => item.value.startsWith("revoke:"))!.value,
    }));
    const context = {
      args: "",
      interaction: {
        select,
        pause: vi.fn(),
        resume: vi.fn(),
        line: vi.fn(),
        spacer: vi.fn(),
      },
    } satisfies CommandContext;

    await createPermissionsCommand(app, text).execute(context);

    expect(revokePersistentApproval).toHaveBeenCalledWith("grant-id");
    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        items: expect.arrayContaining([
          expect.objectContaining({ label: "Revoke Always trust executable: mycli" }),
        ]),
      }),
    );
  });
});
