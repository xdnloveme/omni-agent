import { describe, expect, it } from "vitest";
import { CliUsageError, parseCliArgs } from "./args";

describe("parseCliArgs", () => {
  it.each([
    [[], { kind: "run", agentId: "coding", trace: false }],
    [["--trace"], { kind: "run", agentId: "coding", trace: true }],
    [["run"], { kind: "run", agentId: "coding", trace: false }],
    [["run", "coding"], { kind: "run", agentId: "coding", trace: false }],
    [["run", "coding", "--trace"], { kind: "run", agentId: "coding", trace: true }],
    [
      ["run", "--trace", "financial-analysis"],
      { kind: "run", agentId: "financial-analysis", trace: true },
    ],
    [["run", "financial-analysis"], { kind: "run", agentId: "financial-analysis", trace: false }],
    [["trace", "preview", "coding"], { kind: "trace-preview", agentId: "coding" }],
    [
      ["trace", "clear", "financial-analysis"],
      { kind: "trace-clear", agentId: "financial-analysis", confirmed: false },
    ],
    [
      ["trace", "clear", "coding", "--yes"],
      { kind: "trace-clear", agentId: "coding", confirmed: true },
    ],
    [["doctor"], { kind: "doctor" }],
    [
      ["agent", "describe", "coding"],
      { kind: "agent-inspection", action: "describe", agentId: "coding", json: false },
    ],
    [
      ["agent", "--json", "validate", "coding"],
      { kind: "agent-inspection", action: "validate", agentId: "coding", json: true },
    ],
    [
      ["agent", "plan", "financial-analysis", "--json"],
      {
        kind: "agent-inspection",
        action: "plan",
        agentId: "financial-analysis",
        json: true,
      },
    ],
    [
      ["agent", "create", "release-notes", "./release-notes-agent"],
      {
        kind: "agent-create",
        agentId: "release-notes",
        directory: "./release-notes-agent",
      },
    ],
    [["--help"], { kind: "help" }],
    [["-h"], { kind: "help" }],
    [["--version"], { kind: "version" }],
  ])("parses %j", (input, expected) => {
    expect(parseCliArgs(input)).toEqual(expected);
  });

  it.each([
    ["chat"],
    ["run", "../unknown"],
    ["run", "coding", "extra"],
    ["run", "coding", "--trace", "--trace"],
    ["--trace", "run"],
    ["trace", "preview", "../coding"],
    ["trace", "unknown", "coding"],
    ["agent", "inspect", "coding"],
    ["agent", "plan", "../coding"],
    ["agent", "plan", "coding", "--json", "--json"],
    ["agent", "plan", "coding", "extra"],
    ["agent", "create", "../coding", "./coding"],
    ["agent", "create", "coding"],
    ["agent", "create", "coding", "./coding", "extra"],
  ])("rejects invalid input %j as a usage error", (...input) => {
    expect(() => parseCliArgs(input)).toThrow(CliUsageError);
  });
});
