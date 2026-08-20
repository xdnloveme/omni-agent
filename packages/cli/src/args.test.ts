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
  ])("rejects invalid input %j as a usage error", (...input) => {
    expect(() => parseCliArgs(input)).toThrow(CliUsageError);
  });
});
