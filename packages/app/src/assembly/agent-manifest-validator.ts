import { isAgentId, isToolOriginId } from "@omni-agent/core";
import type { AgentManifest } from "./contracts";
import {
  AgentManifestError,
  invalidManifest,
  parseAgentManifestDocument,
  type ManifestLocation,
} from "./agent-manifest-parser";
import { deepFreeze } from "./deep-freeze";

export { AgentManifestError, MAX_AGENT_MANIFEST_BYTES } from "./agent-manifest-parser";

export function parseAgentManifest(sourceText: string, source: string): AgentManifest {
  const document = parseAgentManifestDocument(sourceText, source);
  return validateManifestObject(document.value, source, document.locate);
}

function validateManifestObject(
  value: Record<string, unknown>,
  source: string,
  locate: (path: readonly (string | number)[]) => ManifestLocation,
): AgentManifest {
  if ("apiVersion" in value && value.apiVersion !== "omni-agent/v2") {
    throw new AgentManifestError(
      "agent_package_incompatible",
      `Unsupported apiVersion: ${String(value.apiVersion)}`,
      source,
      locate(["apiVersion"]).line,
      locate(["apiVersion"]).column,
    );
  }
  assertKeys(
    value,
    ["apiVersion", "kind", "metadata", "runtime", "description", "composition"],
    source,
    "root",
    [],
    locate,
  );
  if (value.kind !== "Agent") throw invalid(source, "kind must be Agent", locate(["kind"]));
  const metadata = record(value.metadata, source, "metadata", locate(["metadata"]));
  assertKeys(metadata, ["id", "displayName"], source, "metadata", ["metadata"], locate);
  if (typeof metadata.id !== "string" || !isAgentId(metadata.id)) {
    throw invalid(source, "metadata.id must be a valid Agent id", locate(["metadata", "id"]));
  }
  assertNonEmpty(
    metadata.displayName,
    source,
    "metadata.displayName",
    locate(["metadata", "displayName"]),
  );
  const runtime = record(value.runtime, source, "runtime", locate(["runtime"]));
  assertKeys(runtime, ["blueprintApiVersion"], source, "runtime", ["runtime"], locate);
  if (runtime.blueprintApiVersion !== 2) {
    throw new AgentManifestError(
      "agent_package_incompatible",
      `Unsupported blueprintApiVersion: ${String(runtime.blueprintApiVersion)}`,
      source,
      locate(["runtime", "blueprintApiVersion"]).line,
      locate(["runtime", "blueprintApiVersion"]).column,
    );
  }
  assertNonEmpty(value.description, source, "description", locate(["description"]));
  validateComposition(value.composition, source, locate);
  return deepFreeze(value as unknown as AgentManifest);
}

function validateComposition(
  value: unknown,
  source: string,
  locate: (path: readonly (string | number)[]) => ManifestLocation,
): void {
  const composition = record(value, source, "composition", locate(["composition"]));
  assertKeys(
    composition,
    ["prompt", "tools", "capabilities"],
    source,
    "composition",
    ["composition"],
    locate,
  );
  const prompt = record(
    composition.prompt,
    source,
    "composition.prompt",
    locate(["composition", "prompt"]),
  );
  assertKeys(
    prompt,
    ["profile", "contributors"],
    source,
    "composition.prompt",
    ["composition", "prompt"],
    locate,
  );
  assertComponentId(
    prompt.profile,
    source,
    "composition.prompt.profile",
    locate(["composition", "prompt", "profile"]),
  );
  assertComponentIdArray(
    prompt.contributors,
    source,
    "composition.prompt.contributors",
    ["composition", "prompt", "contributors"],
    locate,
  );

  const tools = record(
    composition.tools,
    source,
    "composition.tools",
    locate(["composition", "tools"]),
  );
  assertKeys(tools, ["sequence"], source, "composition.tools", ["composition", "tools"], locate);
  validateToolSequence(tools.sequence, source, locate);

  const capabilities = record(
    composition.capabilities,
    source,
    "composition.capabilities",
    locate(["composition", "capabilities"]),
  );
  assertOptionalKeys(
    capabilities,
    ["skills", "context"],
    source,
    "composition.capabilities",
    ["composition", "capabilities"],
    locate,
  );
  if (capabilities.skills !== undefined) {
    assertComponentId(
      capabilities.skills,
      source,
      "composition.capabilities.skills",
      locate(["composition", "capabilities", "skills"]),
    );
  }
  if (capabilities.context !== undefined) {
    const context = record(
      capabilities.context,
      source,
      "composition.capabilities.context",
      locate(["composition", "capabilities", "context"]),
    );
    assertOptionalKeys(
      context,
      ["artifactRecovery"],
      source,
      "composition.capabilities.context",
      ["composition", "capabilities", "context"],
      locate,
    );
    if (context.artifactRecovery !== undefined) {
      assertComponentId(
        context.artifactRecovery,
        source,
        "composition.capabilities.context.artifactRecovery",
        locate(["composition", "capabilities", "context", "artifactRecovery"]),
      );
    }
  }
}

function validateToolSequence(
  value: unknown,
  source: string,
  locate: (path: readonly (string | number)[]) => ManifestLocation,
): void {
  const path = ["composition", "tools", "sequence"] as const;
  if (!Array.isArray(value)) {
    throw invalid(source, "composition.tools.sequence must be a sequence", locate(path));
  }
  for (const [index, entry] of value.entries()) {
    const entryPath = [...path, index];
    const reference = record(
      entry,
      source,
      `composition.tools.sequence[${index}]`,
      locate(entryPath),
    );
    const keys = Object.keys(reference);
    if (keys.length !== 1 || (keys[0] !== "bundle" && keys[0] !== "tool")) {
      throw invalid(
        source,
        `composition.tools.sequence[${index}] must contain exactly one of bundle or tool`,
        locate(entryPath),
      );
    }
    const key = keys[0]!;
    assertComponentId(
      reference[key],
      source,
      `composition.tools.sequence[${index}].${key}`,
      locate([...entryPath, key]),
    );
  }
}

function assertKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  source: string,
  label: string,
  path: readonly (string | number)[],
  locate: (path: readonly (string | number)[]) => ManifestLocation,
): void {
  const actual = Object.keys(value);
  const unknown = actual.filter((key) => !expected.includes(key));
  const missing = expected.filter((key) => !actual.includes(key));
  if (unknown.length > 0)
    throw invalid(
      source,
      `${label} has unknown fields: ${unknown.join(", ")}`,
      locate([...path, unknown[0]!]),
    );
  if (missing.length > 0)
    throw invalid(source, `${label} is missing fields: ${missing.join(", ")}`, locate(path));
}

function assertOptionalKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  source: string,
  label: string,
  path: readonly (string | number)[],
  locate: (path: readonly (string | number)[]) => ManifestLocation,
): void {
  const unknown = Object.keys(value).filter((key) => !expected.includes(key));
  if (unknown.length > 0) {
    throw invalid(
      source,
      `${label} has unknown fields: ${unknown.join(", ")}`,
      locate([...path, unknown[0]!]),
    );
  }
}

function assertComponentIdArray(
  value: unknown,
  source: string,
  label: string,
  path: readonly (string | number)[],
  locate: (path: readonly (string | number)[]) => ManifestLocation,
): void {
  if (!Array.isArray(value)) throw invalid(source, `${label} must be a sequence`, locate(path));
  for (const [index, entry] of value.entries()) {
    assertComponentId(entry, source, `${label}[${index}]`, locate([...path, index]));
  }
}

function assertComponentId(
  value: unknown,
  source: string,
  label: string,
  location: ManifestLocation,
): void {
  if (typeof value !== "string" || !isToolOriginId(value)) {
    throw invalid(source, `${label} must be a valid Component id`, location);
  }
}

function record(
  value: unknown,
  source: string,
  label: string,
  location: ManifestLocation,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalid(source, `${label} must be a mapping`, location);
  }
  return value as Record<string, unknown>;
}

function assertNonEmpty(
  value: unknown,
  source: string,
  label: string,
  location: ManifestLocation,
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalid(source, `${label} must be a non-empty string`, location);
  }
}

function invalid(
  source: string,
  message: string,
  location: ManifestLocation,
  cause?: unknown,
): AgentManifestError {
  return invalidManifest(source, message, location, cause);
}
