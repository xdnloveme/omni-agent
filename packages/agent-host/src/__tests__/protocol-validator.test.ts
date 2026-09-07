import { describe, expect, it } from "vitest";
import { AgentHostProtocolValidator } from "../protocol-validator";

describe("AgentHostProtocolValidator", () => {
  const validator = new AgentHostProtocolValidator();

  it("accepts Protocol v2 hello and Service requests without changing their values", () => {
    const hello = { v: 2, type: "hello", token: "A".repeat(43) };
    const run = {
      v: 2,
      id: "run:1",
      type: "run",
      agentId: "coding",
      sessionId: "session-1",
      text: "hello",
    };

    expect(validator.parse(JSON.stringify(hello))).toEqual(hello);
    expect(validator.parse(JSON.stringify(run))).toEqual(run);
  });

  it("rejects unknown fields, invalid JSON, and unsupported versions", () => {
    expect(() => validator.parse("not-json")).toThrowError(
      expect.objectContaining({ code: "invalid_message" }),
    );
    expect(() =>
      validator.parse(JSON.stringify({ v: 1, id: "list", type: "list_agents" })),
    ).toThrowError(expect.objectContaining({ code: "unsupported_version" }));
    expect(() =>
      validator.parse(JSON.stringify({ v: 2, id: "list", type: "list_agents", cwd: "/tmp" })),
    ).toThrowError(expect.objectContaining({ code: "invalid_message" }));
  });

  it("rejects oversized messages and unsafe request identifiers", () => {
    expect(() =>
      validator.parse(
        JSON.stringify({
          v: 2,
          id: "run",
          type: "run",
          agentId: "coding",
          sessionId: "session",
          text: "x".repeat(70_000),
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "payload_too_large" }));
    expect(() =>
      validator.parse(JSON.stringify({ v: 2, id: "unsafe id", type: "list_agents" })),
    ).toThrowError(expect.objectContaining({ code: "invalid_message" }));
  });
});
