import { describe, expect, it } from "vitest";
import { resolveToolTimeout } from "../execution";
import { ToolDefinitionValidator, ToolInputValidator } from "../tool-calls";
import type { AgentToolDefinition } from "../types";

describe("ToolInputValidator", () => {
  it("validates required fields and rejects additional properties", () => {
    const validator = new ToolInputValidator();
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: { value: { type: "string", minLength: 1 } },
      required: ["value"],
    };
    expect(validator.validate(schema, { value: "ok" })).toBeNull();
    expect(validator.validate(schema, {})).toContain("required property");
    expect(validator.validate(schema, { value: "ok", extra: true })).toContain(
      "additional properties",
    );
  });

  it("rejects an invalid schema during compilation", () => {
    const validator = new ToolInputValidator();
    expect(() => validator.assertValidSchema({ type: "not-a-json-type" })).toThrow();
  });
});

describe("ToolDefinitionValidator", () => {
  const tool = (): AgentToolDefinition => ({
    name: "test",
    description: "test tool",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        timeout_ms: { type: "integer", minimum: 1_000, maximum: 10_000 },
      },
    },
    authorization: { kind: "static", risk: "read", reason: "test" },
    execution: { kind: "host" },
    timeout: {
      kind: "input",
      parameter: "timeout_ms",
      defaultMs: 5_000,
      minMs: 1_000,
      maxMs: 10_000,
    },
    async execute() {
      return { content: [{ type: "text", text: "ok" }], isError: false };
    },
  });

  it("accepts an input timeout that exactly matches the schema", () => {
    const definition = tool();
    expect(() => new ToolDefinitionValidator().validate(definition)).not.toThrow();
    expect(resolveToolTimeout(definition.timeout, {})).toBe(5_000);
    expect(resolveToolTimeout(definition.timeout, { timeout_ms: 8_000 })).toBe(8_000);
  });

  it("rejects a timeout policy whose range differs from the schema", () => {
    const invalid = tool();
    invalid.timeout = {
      kind: "input",
      parameter: "timeout_ms",
      defaultMs: 5_000,
      minMs: 1_000,
      maxMs: 20_000,
    };
    expect(() => new ToolDefinitionValidator().validate(invalid)).toThrow(
      "Timeout policy does not match schema",
    );
  });

  it("rejects fixed timeouts larger than the Node timer range", () => {
    const invalid = tool();
    invalid.timeout = { kind: "fixed", timeoutMs: 2_147_483_648 };
    expect(() => new ToolDefinitionValidator().validate(invalid)).toThrow(
      "Invalid fixed tool timeout",
    );
  });

  it("requires an invocation resource to reference a string schema property", () => {
    const invalid = tool();
    invalid.invocation = {
      action: "execute",
      resource: { kind: "command", inputKey: "timeout_ms" },
    };

    expect(() => new ToolDefinitionValidator().validate(invalid)).toThrow(
      "Tool invocation resource must reference a string",
    );
  });

  it("rejects a non-function dynamic authorization input binder", () => {
    const invalid = tool();
    invalid.authorization = {
      kind: "dynamic",
      bindInput: "invalid",
      assess: () => ({
        risk: "read",
        operationClass: "routine",
        enforcement: "policy",
        reasons: ["read"],
        presentation: { title: "Read", reason: "read" },
        ruleIds: [],
      }),
    } as never;

    expect(() => new ToolDefinitionValidator().validate(invalid)).toThrow(
      "Dynamic authorization input binder is invalid",
    );
  });
});
