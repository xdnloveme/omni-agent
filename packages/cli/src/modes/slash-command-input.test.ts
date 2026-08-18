import { describe, expect, it } from "vitest";
import { parseSlashCommandInput } from "./slash-command-input";

describe("parseSlashCommandInput", () => {
  it.each([
    ["/", { name: "help", args: "" }],
    ["/help first line\nsecond line", { name: "help", args: "first line\nsecond line" }],
    ["/review-plan inspect this", { name: "review-plan", args: "inspect this" }],
  ])("parses %j", (input, expected) => {
    expect(parseSlashCommandInput(input)).toEqual(expected);
  });

  it.each(["/workspace/docs/design\\ plan.md review this", "use /review-plan here", "  /help"])(
    "ignores non-command input %j",
    (input) => {
      expect(parseSlashCommandInput(input)).toBeNull();
    },
  );
});
