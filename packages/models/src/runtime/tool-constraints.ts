import type {
  ModelToolSpec,
  ToolConstraintCapability,
  ToolConstraintDecision,
  ToolConstraintReport,
} from "@omni-agent/core";
import { readCompatBoolean } from "../cache/capability";
import type { CompatibleModelDefinition } from "../providers/custom/types";
import type { ProviderCacheModel } from "../vendors/provider-contribution-type";

export function configuredToolConstraintCapability(
  model: ProviderCacheModel,
  definitions: readonly CompatibleModelDefinition[],
  connection?: boolean,
): ToolConstraintCapability {
  const effective = readCompatBoolean(model.compat, "supportsStrictMode");
  // Use the current catalog snapshot, including refreshes, not stale factory definitions.
  if (effective !== undefined) {
    const original = definitions.find((entry) => entry.id === model.id)?.supportsStrictMode;
    const source =
      original === effective ? "model" : connection === effective ? "connection" : "catalog";
    return capability(effective, source);
  }
  if (connection !== undefined) return capability(connection, "connection");
  return { state: "unknown", source: "unknown" };
}

export function catalogToolConstraintCapability(compat: unknown): ToolConstraintCapability {
  const declared =
    readCompatBoolean(compat, "supportsStrictMode") ??
    readCompatBoolean(compat, "supportsStrictTools");
  return declared === undefined
    ? { state: "unknown", source: "unknown" }
    : capability(declared, "catalog");
}

function capability(
  value: boolean,
  source: ToolConstraintCapability["source"],
): ToolConstraintCapability {
  if (typeof value !== "boolean") throw new Error("Strict tool capability must be boolean");
  return { state: value ? "supported" : "unsupported", source };
}

/** A single immutable decision drives protocol conversion and observation. */
export function resolveToolConstraints(
  tools: readonly ModelToolSpec[] | undefined,
  api: string,
  providerCapability: ToolConstraintCapability,
): ToolConstraintReport {
  const decisions: ToolConstraintDecision[] = (tools ?? []).map((tool) => {
    const intent: ToolConstraintDecision["intent"] = tool.inputConstraint ?? "unspecified";
    if (!["unspecified", "off", "prefer", "require"].includes(intent) || "strict" in tool)
      throw new Error(`Invalid input constraint declaration: ${tool.name}`);
    const base = { toolName: tool.name, intent, capability: { ...providerCapability } };
    if (intent === "unspecified" || intent === "off")
      return { ...base, schema: "not_checked", outcome: "disabled", reason: "not_requested" };
    if (providerCapability.state !== "supported")
      return {
        ...base,
        schema: "not_checked",
        outcome: intent === "require" ? "rejected" : "disabled",
        reason: `capability_${providerCapability.state}`,
      };
    const schema = checkStrictSchema(tool.schema, api);
    return {
      ...base,
      schema: schema.state,
      outcome:
        schema.state === "compatible" ? "enabled" : intent === "require" ? "rejected" : "disabled",
      reason: schema.reason,
      ...(schema.path === undefined ? {} : { schemaPath: schema.path }),
    };
  });
  const rejected = decisions.find((decision) => decision.outcome === "rejected");
  return {
    decisions,
    ...(rejected
      ? {
          failure: {
            code: "model_tool_constraint_unsatisfied",
            message: `Tool ${rejected.toolName} requires constrained generation: ${rejected.reason}`,
            retryable: false,
          },
        }
      : {}),
  };
}

type SchemaCheck = {
  state: "compatible" | "incompatible" | "unknown";
  reason: string;
  path?: string;
};
const PORTABLE_KEYS = new Set([
  "type",
  "description",
  "title",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
]);
const TYPES = new Set(["string", "number", "integer", "boolean", "null", "object", "array"]);

/** Verify a conservative common subset, without rewriting the tool's schema.
 * Features outside the verified subset remain unknown, not silently stripped.
 * Bounds deliberately stay below provider limits and bound inspection work. */
function checkStrictSchema(schema: ModelToolSpec["schema"], api: string): SchemaCheck {
  if (
    !["openai-completions", "openai-responses", "anthropic-messages", "omni-custom"].includes(api)
  )
    return { state: "unknown", reason: "protocol_schema_not_verified" };
  let nodes = 0;
  const issue = (
    reason: string,
    path: string,
    state: SchemaCheck["state"] = "unknown",
  ): SchemaCheck => ({ state, reason, path: path.slice(0, 256) });
  const visit = (value: unknown, path: string, depth: number): SchemaCheck | undefined => {
    if (++nodes > 64 || depth > 4) return issue("schema_outside_verified_bounds", path);
    if (!value || typeof value !== "object" || Array.isArray(value))
      return issue("schema_not_verified", path);
    const node = value as Record<string, unknown>;
    if (Object.keys(node).some((key) => !PORTABLE_KEYS.has(key)))
      return issue("schema_keyword_not_verified", path);
    if (typeof node.type !== "string" || !TYPES.has(node.type))
      return issue("schema_type_not_verified", path);
    if (
      node.enum !== undefined &&
      (!Array.isArray(node.enum) ||
        node.enum.length > 32 ||
        node.enum.some(
          (v) =>
            (v !== null && !["string", "boolean", "number"].includes(typeof v)) ||
            (typeof v === "string" && v.length > 256),
        ))
    )
      return issue("schema_enum_not_verified", path);
    if (node.type === "object") {
      if (node.additionalProperties !== false)
        return issue("schema_open_object", path, "incompatible");
      if (!node.properties || typeof node.properties !== "object" || Array.isArray(node.properties))
        return issue("schema_properties_not_verified", path);
      const entries = Object.entries(node.properties);
      const required = Array.isArray(node.required) ? node.required : [];
      if (entries.some(([key]) => !required.includes(key)))
        return issue(
          "schema_optional_properties",
          path,
          api.startsWith("openai-") ? "incompatible" : "unknown",
        );
      for (const [key, child] of entries) {
        const result = visit(
          child,
          `${path}/properties/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`,
          depth + 1,
        );
        if (result) return result;
      }
    } else if (node.type === "array") {
      return visit(node.items, `${path}/items`, depth + 1);
    }
    return undefined;
  };
  if (schema.type !== "object")
    return { state: "incompatible", reason: "schema_root_not_object", path: "" };
  return visit(schema, "", 0) ?? { state: "compatible", reason: "verified_schema_subset" };
}
