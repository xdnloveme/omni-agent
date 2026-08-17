import { describe, expect, it } from "vitest";
import { CliUsageError, parseCliArgs } from "./args";

describe("parseCliArgs", () => {
  it.each([
    [[], { kind: "run", agentId: "coding" }],
    [["run"], { kind: "run", agentId: "coding" }],
    [["run", "coding"], { kind: "run", agentId: "coding" }],
    [["run", "financial-analysis"], { kind: "run", agentId: "financial-analysis" }],
    [["doctor"], { kind: "doctor" }],
    [["--help"], { kind: "help" }],
    [["-h"], { kind: "help" }],
    [["--version"], { kind: "version" }],
  ])("parses %j", (input, expected) => {
    expect(parseCliArgs(input)).toEqual(expected);
  });

  it.each([["chat"], ["run", "../unknown"], ["run", "coding", "extra"]])(
    "rejects invalid input %j as a usage error",
    (...input) => {
      expect(() => parseCliArgs(input)).toThrow(CliUsageError);
    },
  );
});
