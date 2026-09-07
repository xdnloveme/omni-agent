import { describe, expect, it } from "vitest";
import { HOST_COMMAND_NAMES } from "./index";

describe("Host command reservations", () => {
  it("reserves every command that the CLI registers after extensions are validated", () => {
    expect(HOST_COMMAND_NAMES).toEqual([
      "config",
      "permissions",
      "help",
      "new",
      "clear",
      "skills",
      "trace",
      "mcp",
    ]);
  });
});
