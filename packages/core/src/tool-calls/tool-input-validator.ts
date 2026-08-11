import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";

export class ToolInputValidator {
  private readonly ajv = new Ajv({ allErrors: true, strict: false });
  private readonly cache = new WeakMap<object, ValidateFunction>();

  validate(schema: Record<string, unknown>, input: Record<string, unknown>): string | null {
    const validator = this.compile(schema);
    return validator(input) ? null : formatErrors(validator.errors);
  }

  assertValidSchema(schema: Record<string, unknown>): void {
    this.compile(schema);
  }

  private compile(schema: Record<string, unknown>): ValidateFunction {
    const cached = this.cache.get(schema);
    if (cached) return cached;
    const validator = this.ajv.compile(schema);
    this.cache.set(schema, validator);
    return validator;
  }
}

function formatErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors?.length) return "input does not match the tool schema";
  return errors
    .map((error) => `${error.instancePath || "input"} ${error.message ?? "is invalid"}`)
    .join("; ");
}
