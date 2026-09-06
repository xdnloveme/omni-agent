import { describe, expect, it } from "vitest";
import { AgentHostProtocolValidator } from "../protocol-validator";

describe("AgentHostProtocolValidator", () => {
  const validator = new AgentHostProtocolValidator();

  it("accepts Protocol v1 hello and Service requests without changing their values", () => {
    const hello = { v: 1, type: "hello", token: "A".repeat(43) };
    const run = {
      v: 1,
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
      validator.parse(JSON.stringify({ v: 2, id: "list", type: "list_agents" })),
    ).toThrowError(expect.objectContaining({ code: "unsupported_version" }));
    expect(() =>
      validator.parse(JSON.stringify({ v: 1, id: "list", type: "list_agents", cwd: "/tmp" })),
    ).toThrowError(expect.objectContaining({ code: "invalid_message" }));
  });

  it("rejects oversized messages and unsafe request identifiers", () => {
    expect(() =>
      validator.parse(
        JSON.stringify({
          v: 1,
          id: "run",
          type: "run",
          agentId: "coding",
          sessionId: "session",
          text: "x".repeat(70_000),
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "payload_too_large" }));
    expect(() =>
      validator.parse(JSON.stringify({ v: 1, id: "unsafe id", type: "list_agents" })),
    ).toThrowError(expect.objectContaining({ code: "invalid_message" }));
  });

  it("strictly validates every Protocol v1 server response variant", () => {
    const completed = {
      v: 1,
      type: "event",
      requestId: "run-1",
      event: { type: "completed" },
    };

    expect(validator.parseServerMessage(JSON.stringify(completed))).toEqual(completed);
    expect(
      validator.parseServerMessage(
        JSON.stringify({
          v: 1,
          type: "event",
          requestId: "run-1",
          event: { type: "text_delta", text: "x".repeat(70_000) },
        }),
      ),
    ).toMatchObject({ event: { type: "text_delta" } });
    expect(() =>
      validator.parseServerMessage(
        JSON.stringify({
          v: 1,
          type: "result",
          id: "session-1",
          result: { kind: "session" },
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "invalid_message" }));
    expect(() =>
      validator.parseServerMessage(
        JSON.stringify({
          v: 1,
          type: "event",
          requestId: "run-1",
          event: { type: "text_delta" },
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "invalid_message" }));
  });
});
