import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import { sanitizeSensitiveValue } from "../security";

export interface ToolInputDiagnostic {
  readonly path: string;
  readonly keyword: string;
  readonly message: string;
  readonly field?: string;
  readonly constraint?: string | number;
}

export class ToolInputValidator {
  private readonly ajv = new Ajv({ allErrors: true, strict: false });
  private readonly cache = new WeakMap<object, ValidateFunction>();

  validate(
    schema: Record<string, unknown>,
    input: Record<string, unknown>,
  ): { message: string; issues: ToolInputDiagnostic[]; truncated: boolean } | null {
    const validator = this.compile(schema);
    if (validator(input)) return null;
    // Bound diagnostic amplification; never include input values or schema enum/const contents.
    const errors = validator.errors ?? [];
    const issues = errors.slice(0, 16).map(diagnostic);
    return {
      message: issues
        .map(
          (issue) =>
            `${issue.path || "input"} ${issue.message}${issue.field ? ` (${issue.field})` : ""}${issue.constraint !== undefined ? ` [${issue.constraint}]` : ""}`,
        )
        .join("; "),
      issues,
      truncated: errors.length > issues.length,
    };
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

function diagnostic(error: ErrorObject): ToolInputDiagnostic {
  const bounded = (value: string): string => String(sanitizeSensitiveValue(value)).slice(0, 256);
  const field = error.params.additionalProperty ?? error.params.missingProperty;
  const constraint = error.params.limit ?? error.params.type;
  return {
    path: bounded(error.instancePath),
    keyword: error.keyword,
    message: bounded(error.message ?? "does not match the tool schema"),
    ...(typeof field === "string" ? { field: bounded(field) } : {}),
    ...(typeof constraint === "number" || typeof constraint === "string"
      ? { constraint: typeof constraint === "string" ? bounded(constraint) : constraint }
      : {}),
  };
}
