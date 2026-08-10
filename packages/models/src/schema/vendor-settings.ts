import Ajv, { type ErrorObject, type JSONSchemaType, type ValidateFunction } from "ajv";
import type { JsonValue } from "@omni-agent/core";

const MAX_SCHEMA_BYTES = 64 * 1024;
const MAX_SCHEMA_DEPTH = 8;
const MAX_PROPERTIES = 64;
const MAX_PATTERN_LENGTH = 256;
const SECRET_FIELD_NAMES = new Set([
  "apikey",
  "secret",
  "clientsecret",
  "accesstoken",
  "refreshtoken",
  "bearertoken",
  "idtoken",
  "sessiontoken",
  "authorization",
  "credential",
  "credentials",
  "clientcredentials",
  "privatekey",
  "authheader",
  "password",
]);
const ALLOWED_KEYWORDS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "enum",
  "const",
  "items",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "pattern",
  "description",
  "default",
]);

export type JsonSchemaTypeName = "object" | "array" | "string" | "number" | "integer" | "boolean";

export interface AgentJsonSchema {
  readonly type: JsonSchemaTypeName;
  readonly properties?: Readonly<Record<string, AgentJsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly enum?: readonly JsonValue[];
  readonly const?: JsonValue;
  readonly items?: AgentJsonSchema;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly description?: string;
  readonly default?: JsonValue;
}

export interface VendorSettingsSchema extends AgentJsonSchema {
  readonly type: "object";
}

export class SchemaAdmissionPolicy {
  admit(schema: unknown): VendorSettingsSchema {
    let serialized: string;
    try {
      serialized = JSON.stringify(schema);
    } catch {
      throw new Error("Settings schema must be JSON serializable");
    }
    if (!serialized || Buffer.byteLength(serialized, "utf8") > MAX_SCHEMA_BYTES) {
      throw new Error(`Settings schema exceeds ${MAX_SCHEMA_BYTES} bytes`);
    }
    this.visit(schema, "schema", 1);
    const admitted = schema as VendorSettingsSchema;
    if (admitted.type !== "object") throw new Error("Settings schema root must be an object");
    return admitted;
  }

  private visit(value: unknown, path: string, depth: number): void {
    if (depth > MAX_SCHEMA_DEPTH)
      throw new Error(`Settings schema exceeds depth ${MAX_SCHEMA_DEPTH}`);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${path} must be a schema object`);
    }
    const schema = value as Record<string, unknown>;
    for (const keyword of Object.keys(schema)) {
      if (!ALLOWED_KEYWORDS.has(keyword)) throw new Error(`Unsupported schema keyword: ${keyword}`);
    }
    if (
      !["object", "array", "string", "number", "integer", "boolean"].includes(String(schema.type))
    ) {
      throw new Error(`${path}.type is unsupported`);
    }
    if (schema.type === "object" && schema.additionalProperties !== false) {
      throw new Error(`${path}.additionalProperties must be false`);
    }
    if (schema.pattern !== undefined) {
      if (typeof schema.pattern !== "string" || schema.pattern.length > MAX_PATTERN_LENGTH) {
        throw new Error(`${path}.pattern exceeds ${MAX_PATTERN_LENGTH} characters`);
      }
      try {
        new RegExp(schema.pattern);
      } catch {
        throw new Error(`${path}.pattern is invalid`);
      }
    }
    if (schema.properties !== undefined) {
      if (
        !schema.properties ||
        typeof schema.properties !== "object" ||
        Array.isArray(schema.properties)
      ) {
        throw new Error(`${path}.properties must be an object`);
      }
      const properties = Object.entries(schema.properties as Record<string, unknown>);
      if (properties.length > MAX_PROPERTIES) {
        throw new Error(`${path}.properties exceeds ${MAX_PROPERTIES} entries`);
      }
      for (const [name, child] of properties) {
        if (isSecretFieldName(name))
          throw new Error(`Secret setting schema is not allowed: ${name}`);
        this.visit(child, `${path}.properties.${name}`, depth + 1);
      }
    }
    if (schema.items !== undefined) this.visit(schema.items, `${path}.items`, depth + 1);
    if (schema.required !== undefined) {
      if (!isStringArray(schema.required)) {
        throw new Error(`${path}.required must be an array of strings`);
      }
      const properties = (schema.properties ?? {}) as Record<string, unknown>;
      for (const name of schema.required) {
        if (!Object.hasOwn(properties, name))
          throw new Error(`Required setting has no schema: ${name}`);
      }
    }
  }
}

export interface CompiledValidator<T> {
  validate(value: unknown): T;
}

export class SchemaCompiler {
  private readonly ajv = new Ajv({
    strict: true,
    allErrors: true,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
    allowUnionTypes: false,
  });

  compile(schema: AgentJsonSchema): CompiledValidator<unknown> {
    return this.compileValidator(schema);
  }

  compileObject(schema: VendorSettingsSchema): CompiledValidator<Record<string, JsonValue>> {
    return this.compileValidator(schema);
  }

  compileTyped<T>(schema: JSONSchemaType<T>): CompiledValidator<T> {
    return this.compileValidator(schema);
  }

  private compileValidator<T>(schema: object): CompiledValidator<T> {
    const validate = this.ajv.compile(schema);
    return { validate: (value) => this.validate<T>(validate, value) };
  }

  private validate<T>(validator: ValidateFunction, value: unknown): T {
    if (validator(value)) return value as T;
    throw new Error(formatValidationErrors(validator.errors ?? []));
  }
}

function formatValidationErrors(errors: readonly ErrorObject[]): string {
  return errors
    .map((error) => {
      const path = error.instancePath || "/";
      switch (error.keyword) {
        case "required":
          return `Missing setting: ${String(error.params.missingProperty)}`;
        case "additionalProperties":
          return `Unknown setting: ${String(error.params.additionalProperty)}`;
        case "pattern":
        case "enum":
        case "const":
          return `Invalid setting value for ${path}`;
        default:
          return `Invalid setting at ${path}: ${error.message ?? error.keyword}`;
      }
    })
    .join("; ");
}

export function containsSecretField(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(
    ([key, child]) => isSecretFieldName(key) || containsSecretField(child),
  );
}

function isSecretFieldName(name: string): boolean {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
  const normalized = name.replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (normalized === "credentialaliases") return false;
  return (
    SECRET_FIELD_NAMES.has(normalized) ||
    words.includes("password") ||
    words.includes("secret") ||
    words.includes("authorization") ||
    words.includes("credential") ||
    words.includes("credentials") ||
    hasSensitivePair(words, "api", "key") ||
    hasSensitivePair(words, "private", "key") ||
    hasSensitivePair(words, "auth", "header") ||
    ["access", "refresh", "bearer", "id", "session", "auth"].some((prefix) =>
      hasSensitivePair(words, prefix, "token"),
    )
  );
}

function hasSensitivePair(words: readonly string[], first: string, second: string): boolean {
  return words.some((word, index) => word === first && words[index + 1] === second);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
