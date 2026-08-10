import { describe, expect, it } from "vitest";
import { parseCliArgs } from "./args";

describe("parseCliArgs", () => {
  it("keeps coding as the default agent", () => {
    expect(parseCliArgs([])).toEqual({ mode: "chat", agentId: "coding" });
    expect(parseCliArgs(["chat"])).toEqual({ mode: "chat", agentId: "coding" });
  });

  it("accepts an agent package id without a hard-coded allowlist", () => {
    expect(parseCliArgs(["chat", "financial-analysis"])).toEqual({
      mode: "chat",
      agentId: "financial-analysis",
    });
    expect(parseCliArgs(["chat", "research"])).toEqual({
      mode: "chat",
      agentId: "research",
    });
    expect(parseCliArgs(["chat", "--", "research"])).toEqual({
      mode: "chat",
      agentId: "research",
    });
  });

  it("rejects invalid package ids and trailing arguments", () => {
    expect(() => parseCliArgs(["chat", "../unknown"])).toThrow("Invalid agent id: ../unknown");
    expect(() => parseCliArgs(["chat", "coding", "extra"])).toThrow("Unexpected argument: extra");
  });
});
