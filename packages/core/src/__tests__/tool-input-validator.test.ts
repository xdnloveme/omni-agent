import { describe, expect, it } from "vitest";
import { ToolInputValidator } from "../tool-calls/tool-input-validator";

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
