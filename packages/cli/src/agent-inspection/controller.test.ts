import { afterEach, describe, expect, it, vi } from "vitest";
import { agentBlueprint } from "@omni-agent/agent-coding";
import type { CliHostServices } from "../host-services";
import { runAgentInspection } from "./controller";

afterEach(() => vi.restoreAllMocks());

function host() {
  const stdout = vi.fn();
  const stderr = vi.fn();
  return {
    stdout,
    stderr,
    value: {
      runtime: {
        cwd: process.cwd(),
        cliEntry: import.meta.filename,
        globalDirectory: ".omni-agent",
        agentPackagesDirectory: ".omni-agent/agents",
        nodeVersion: process.versions.node,
      },
      output: { stdout, stderr },
    } as unknown as CliHostServices,
  };
}

describe("Agent inspection", () => {
  it("describes the discoverable Catalog without building the Blueprint", async () => {
    const output = host();
    const build = vi.spyOn(agentBlueprint, "build");

    const result = await runAgentInspection("describe", "coding", false, output.value);

    expect(result.exitCode).toBe(0);
    expect(output.stdout.mock.calls[0]?.[0]).toContain("coding.workspace");
    expect(output.stdout.mock.calls[0]?.[0]).toContain("skills.read");
    expect(output.stderr).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
  });

  it("validates and plans as machine-readable documents without Runtime resources", async () => {
    const validation = host();
    const plan = host();
    const build = vi.spyOn(agentBlueprint, "build");

    await expect(runAgentInspection("validate", "coding", true, validation.value)).resolves.toEqual(
      { exitCode: 0 },
    );
    await expect(runAgentInspection("plan", "coding", true, plan.value)).resolves.toEqual({
      exitCode: 0,
    });

    const validationDocument = JSON.parse(validation.stdout.mock.calls[0]?.[0]);
    const planDocument = JSON.parse(plan.stdout.mock.calls[0]?.[0]);
    expect(validationDocument).toMatchObject({ kind: "AgentValidation", valid: true });
    expect(planDocument).toMatchObject({
      kind: "AgentCompositionPlan",
      composition: {
        tools: {
          toolNames: [
            "bash",
            "file_read",
            "file_edit",
            "file_write",
            "glob",
            "grep",
            "web_fetch",
            "web_search",
            "request_user_input",
            "skill_read",
          ],
        },
      },
    });
    expect(build).not.toHaveBeenCalled();
  });

  it("emits one JSON error document and a failing exit code", async () => {
    const output = host();

    const result = await runAgentInspection("plan", "missing", true, output.value);

    expect(result.exitCode).toBe(1);
    expect(output.stderr).not.toHaveBeenCalled();
    expect(JSON.parse(output.stdout.mock.calls[0]?.[0])).toMatchObject({
      kind: "AgentInspectionError",
      action: "plan",
      agentId: "missing",
    });
  });
});
