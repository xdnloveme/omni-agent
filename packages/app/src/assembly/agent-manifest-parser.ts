import { isJsonValue } from "@omni-agent/core";
import { isAlias, isMap, LineCounter, parseDocument, visit, type Node } from "yaml";

export const MAX_AGENT_MANIFEST_BYTES = 64 * 1024;

export interface ManifestLocation {
  readonly line: number;
  readonly column: number;
}

export interface ParsedAgentManifestDocument {
  readonly value: Record<string, unknown>;
  locate(path: readonly (string | number)[]): ManifestLocation;
}

export class AgentManifestError extends Error {
  constructor(
    readonly code: "agent_manifest_invalid" | "agent_package_incompatible",
    message: string,
    readonly source: string,
    readonly line: number,
    readonly column: number,
    options?: ErrorOptions,
  ) {
    super(`${source}:${line}:${column}: ${message}`, options);
    this.name = "AgentManifestError";
  }
}

export function parseAgentManifestDocument(
  sourceText: string,
  source: string,
): ParsedAgentManifestDocument {
  if (Buffer.byteLength(sourceText, "utf8") > MAX_AGENT_MANIFEST_BYTES) {
    throw invalid(source, `Manifest exceeds ${MAX_AGENT_MANIFEST_BYTES} bytes`, {
      line: 1,
      column: 1,
    });
  }
  const lineCounter = new LineCounter();
  let document;
  try {
    document = parseDocument(sourceText, {
      customTags: [],
      merge: false,
      prettyErrors: true,
      strict: true,
      uniqueKeys: true,
      lineCounter,
    });
  } catch (error) {
    throw invalid(source, messageOf(error), errorLocation(error), error);
  }
  if (document.errors.length > 0) {
    throw invalid(
      source,
      document.errors.map((error) => error.message).join("; "),
      errorLocation(document.errors[0]),
    );
  }
  const locateNode = (node: Node | null | undefined): ManifestLocation => {
    const offset = node?.range?.[0];
    if (typeof offset !== "number") return { line: 1, column: 1 };
    const position = lineCounter.linePos(offset);
    return { line: position.line, column: position.col };
  };
  if (!isMap(document.contents)) {
    throw invalid(source, "Manifest root must be a mapping", locateNode(document.contents));
  }
  visit(document, (_key, node) =>
    validateYamlNode(node as Node | null | undefined, source, locateNode),
  );

  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 0, mapAsMap: false });
  } catch (error) {
    throw invalid(source, messageOf(error), errorLocation(error), error);
  }
  if (!isJsonValue(value) || Array.isArray(value) || value === null) {
    throw invalid(source, "Manifest must contain a JSON-compatible object", {
      line: 1,
      column: 1,
    });
  }
  return {
    value: value as Record<string, unknown>,
    locate: (path) => locateNode(document.getIn([...path], true) as Node | null | undefined),
  };
}

export function invalidManifest(
  source: string,
  message: string,
  location: ManifestLocation,
  cause?: unknown,
): AgentManifestError {
  return new AgentManifestError(
    "agent_manifest_invalid",
    message,
    source,
    location.line,
    location.column,
    cause ? { cause } : undefined,
  );
}

function validateYamlNode(
  node: Node | null | undefined,
  source: string,
  locate: (node: Node | null | undefined) => ManifestLocation,
): void {
  if (!node) return;
  if (isAlias(node)) throw invalid(source, "YAML aliases are not supported", locate(node));
  if (node.tag && !node.tag.startsWith("tag:yaml.org,2002:")) {
    throw invalid(source, `Custom YAML tag is not supported: ${node.tag}`, locate(node));
  }
  if (isMap(node)) {
    for (const item of node.items) {
      if (String((item.key as { value?: unknown } | null)?.value) === "<<") {
        throw invalid(source, "YAML merge keys are not supported", locate(item.key as Node));
      }
    }
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

function errorLocation(error: unknown): ManifestLocation {
  const linePos = (
    error as {
      linePos?: readonly {
        readonly line: number;
        readonly col?: number;
        readonly column?: number;
      }[];
    } | null
  )?.linePos?.[0];
  return linePos
    ? { line: linePos.line, column: linePos.column ?? linePos.col ?? 1 }
    : { line: 1, column: 1 };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
