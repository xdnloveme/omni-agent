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
    expect(validator.validate(schema, {})?.message).toContain("required property");
    expect(validator.validate(schema, { value: "ok", extra: true })?.message).toContain(
      "additional properties",
    );
  });

  it("provides bounded field diagnostics without echoing rejected values", () => {
    const validator = new ToolInputValidator();
    const result = validator.validate(
      {
        type: "object",
        additionalProperties: false,
        required: ["target"],
        properties: { target: { type: "string" }, count: { type: "integer", minimum: 2 } },
      },
      { unexpected: "PRIVATE_INPUT", count: 0 },
    );
    expect(result?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ keyword: "required", field: "target" }),
        expect.objectContaining({ keyword: "additionalProperties", field: "unexpected" }),
        expect.objectContaining({ path: "/count", keyword: "minimum", constraint: 2 }),
      ]),
    );
    expect(JSON.stringify(result)).not.toContain("PRIVATE_INPUT");
  });

  it("rejects an invalid schema during compilation", () => {
    const validator = new ToolInputValidator();
    expect(() => validator.assertValidSchema({ type: "not-a-json-type" })).toThrow();
  });
});

describe("ToolDefinitionValidator", () => {
  it("rejects removed strict declarations and accepts only explicit input constraint intents", () => {
    const validator = new ToolDefinitionValidator();
    expect(() =>
      validator.validate({ ...tool(), strict: true } as unknown as AgentToolDefinition),
    ).toThrow("replace strict");
    expect(() =>
      validator.validate({ ...tool(), inputConstraint: "auto" } as unknown as AgentToolDefinition),
    ).toThrow("Invalid input constraint");
    for (const inputConstraint of ["off", "prefer", "require"] as const)
      expect(() => validator.validate({ ...tool(), inputConstraint })).not.toThrow();
  });

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
    access: { kind: "internal" },
    execution: { kind: "in_process" },
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

  it("rejects a non-function dynamic access input binder", () => {
    const invalid = tool();
    invalid.access = {
      kind: "dynamic",
      bindInput: "invalid",
      assess: () => ({ resources: [] }),
    } as never;

    expect(() => new ToolDefinitionValidator().validate(invalid)).toThrow(
      "Dynamic access input binder is invalid",
    );
  });
});
