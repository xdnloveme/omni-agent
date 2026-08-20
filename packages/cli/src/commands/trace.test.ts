import { describe, expect, it, vi } from "vitest";
import type { AgentTraceControlCapability } from "@omni-agent/app";
import type { CommandContext } from "@omni-agent/core";
import { createTraceCommand } from "./trace";

describe("trace command", () => {
  it("controls and inspects the Host-owned Trace capability", async () => {
    let enabled = false;
    const trace: AgentTraceControlCapability = {
      control: {
        start: () => {
          enabled = true;
        },
        stop: () => {
          enabled = false;
        },
        status: () => (enabled ? "on" : "off"),
      },
      inspection: {
        location: () => "/trace/coding",
        diskUsage: async () => 2_048,
        activeRuns: async () => 1,
      },
    };
    const interaction = {
      pause: vi.fn(),
      resume: vi.fn(),
      select: vi.fn(),
      line: vi.fn(),
      spacer: vi.fn(),
    };
    const command = createTraceCommand(trace);

    await command.execute({ args: "start", interaction } satisfies CommandContext);
    await command.execute({ args: "status", interaction } satisfies CommandContext);
    await command.execute({ args: "stop", interaction } satisfies CommandContext);

    expect(trace.control.status()).toBe("off");
    expect(interaction.line).toHaveBeenCalledWith("Trace capture is on.");
    expect(interaction.line).toHaveBeenCalledWith("Location: /trace/coding");
    expect(interaction.line).toHaveBeenCalledWith("Disk usage: 2.0 KiB");
    expect(interaction.line).toHaveBeenCalledWith("Active runs: 1");
  });
});
