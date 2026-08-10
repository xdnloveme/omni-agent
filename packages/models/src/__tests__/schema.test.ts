import { describe, expect, it } from "vitest";
import { SchemaAdmissionPolicy, SchemaCompiler } from "../schema/vendor-settings";

describe("agent-facing settings schema", () => {
  const admission = new SchemaAdmissionPolicy();

  it("admits the supported Draft-07 subset and validates without mutating input", () => {
    const schema = admission.admit({
      type: "object",
      properties: {
        region: { type: "string", enum: ["cn", "global"], default: "global" },
      },
      additionalProperties: false,
    });
    const validator = new SchemaCompiler().compileObject(schema);
    const input: Record<string, unknown> = {};

    expect(validator.validate(input)).toBe(input);
    expect(input).toEqual({});
  });

  it.each([
    [{ type: "object", $ref: "https://example.test/schema" }, "Unsupported schema keyword"],
    [
      {
        type: "object",
        properties: { apiKey: { type: "string" } },
        additionalProperties: false,
      },
      "Secret setting schema is not allowed",
    ],
    [
      {
        type: "object",
        properties: { value: { type: "string", pattern: "x".repeat(257) } },
        additionalProperties: false,
      },
      "pattern exceeds 256",
    ],
    [{ type: "object", properties: {} }, "additionalProperties must be false"],
    [
      {
        type: "object",
        properties: { apiKeyValue: { type: "string" } },
        additionalProperties: false,
      },
      "Secret setting schema is not allowed",
    ],
    [
      {
        type: "object",
        properties: { bearerToken: { type: "string" } },
        additionalProperties: false,
      },
      "Secret setting schema is not allowed",
    ],
  ])("rejects an unsafe or unsupported schema", (schema, message) => {
    expect(() => admission.admit(schema)).toThrow(message);
  });

  it("normalizes validation errors without including the rejected value", () => {
    const validator = new SchemaCompiler().compileObject(
      admission.admit({
        type: "object",
        properties: { deploymentId: { type: "string", pattern: "^ep-" } },
        required: ["deploymentId"],
        additionalProperties: false,
      }),
    );

    expect(() => validator.validate({ deploymentId: "secret-value" })).toThrow(
      "Invalid setting value for /deploymentId",
    );
    expect(() => validator.validate({ deploymentId: "secret-value" })).not.toThrow("secret-value");
  });
});
