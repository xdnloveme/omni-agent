import { describe, expect, it } from "vitest";
import { AgentManifestError, parseAgentManifest } from "./agent-manifest-validator";

const valid = `
apiVersion: omni-agent/v2
kind: Agent
metadata:
  id: coding
  displayName: Coding Agent
runtime:
  blueprintApiVersion: 2
description: Coding Agent
composition:
  prompt:
    profile: coding.default
    contributors:
      - workspace.agents-md
  tools:
    sequence:
      - bundle: coding.workspace
  capabilities: {}
`;

describe("parseAgentManifest", () => {
  it("parses the strict JSON-compatible Agent contract", () => {
    expect(parseAgentManifest(valid, "agent.yaml").metadata.id).toBe("coding");
  });

  it("reports Manifest v1 as incompatible without a compatibility path", () => {
    expect(() =>
      parseAgentManifest(valid.replace("omni-agent/v2", "omni-agent/v1"), "agent.yaml"),
    ).toThrowError(expect.objectContaining({ code: "agent_package_incompatible" }));
  });

  it("does not allow runtime policy such as maxTurns in the Recipe", () => {
    expect(() =>
      parseAgentManifest(`${valid}  execution:\n    maxTurns: 8\n`, "agent.yaml"),
    ).toThrow("unknown fields");
  });

  it.each([
    [
      "both Tool reference kinds",
      valid.replace(
        "- bundle: coding.workspace",
        "- bundle: coding.workspace\n        tool: coding.file-read",
      ),
    ],
    ["missing Tool reference kind", valid.replace("- bundle: coding.workspace", "- {}")],
    ["unknown Tool reference field", valid.replace("bundle: coding.workspace", "enabled: true")],
  ])("rejects %s in tools.sequence", (_label, source) => {
    expect(() => parseAgentManifest(source, "agent.yaml")).toThrow("exactly one");
  });

  it.each([
    ["unknown field", `${valid}extra: true\n`],
    ["alias", `${valid}extra: &value test\ncopy: *value\n`],
    ["merge", `${valid}extra:\n  <<: { value: test }\n`],
    ["custom tag", valid.replace("Coding Agent\n", "!custom Coding Agent\n")],
    ["duplicate key", `${valid}kind: Agent\n`],
    ["multiple documents", `${valid}---\nkind: Agent\n`],
  ])("rejects %s", (_label, source) => {
    expect(() => parseAgentManifest(source, "agent.yaml")).toThrow();
  });

  it("rejects oversized input before parsing", () => {
    expect(() => parseAgentManifest(`${valid}#${"x".repeat(70_000)}`, "agent.yaml")).toThrow(
      "exceeds",
    );
  });

  it("reports source, line, and column for schema failures", () => {
    const failure = (() => {
      try {
        parseAgentManifest(
          valid.replace("description:", "unexpected: true\ndescription:"),
          "agent.yaml",
        );
      } catch (error) {
        return error;
      }
    })();

    expect(failure).toBeInstanceOf(AgentManifestError);
    expect(failure).toMatchObject({ source: "agent.yaml", line: 9, column: 13 });
    expect((failure as Error).message).toContain("agent.yaml:9:13");
  });
});
