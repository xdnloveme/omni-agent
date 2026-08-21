import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type {
  ExtensionCandidate,
  ExtensionSourceLoader,
  ExtensionSourceLoadResult,
  ExtensionSourceReference,
} from "./contracts";
import type { AgentExtension } from "../extensions/types";

export class LocalExtensionSourceLoader implements ExtensionSourceLoader {
  async load(references: readonly ExtensionSourceReference[]): Promise<ExtensionSourceLoadResult> {
    const diagnostics: ExtensionSourceLoadResult["diagnostics"][number][] = [];
    const candidates = new Map<string, ExtensionCandidate>();
    for (const reference of references) {
      if (!existsSync(reference.diagnosticSource)) {
        if (reference.requirement === "required") {
          throw sourceFailure(reference, "Extension source does not exist");
        }
        continue;
      }
      try {
        const sourceCandidates = new Map<string, ExtensionCandidate>();
        const loaded = (await import(pathToFileURL(reference.diagnosticSource).href)) as {
          default?: unknown;
        };
        const values = Array.isArray(loaded.default) ? loaded.default : [loaded.default];
        for (const value of values) {
          if (!isAgentExtension(value)) {
            throw new Error("Default export must be an AgentExtension or AgentExtension[]");
          }
          if (sourceCandidates.has(value.manifest.id)) {
            throw new Error(`Duplicate extension id in source: ${value.manifest.id}`);
          }
          sourceCandidates.set(value.manifest.id, { ...reference, extension: value });
        }
        for (const [extensionId, candidate] of sourceCandidates) {
          candidates.set(extensionId, candidate);
        }
      } catch (error) {
        if (reference.requirement === "required") {
          throw sourceFailure(reference, messageOf(error), error);
        }
        diagnostics.push({
          extensionId: "unknown",
          source: reference.diagnosticSource,
          message: messageOf(error),
        });
      }
    }
    return { candidates: [...candidates.values()], diagnostics };
  }
}

function sourceFailure(
  reference: ExtensionSourceReference,
  message: string,
  cause?: unknown,
): Error {
  return new Error(
    `Required extension source failed (${reference.sourceOriginId}): ${message}`,
    cause === undefined ? undefined : { cause },
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAgentExtension(value: unknown): value is AgentExtension {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AgentExtension>;
  return Boolean(
    candidate.manifest &&
    typeof candidate.manifest.id === "string" &&
    candidate.manifest.apiVersion === 1 &&
    candidate.contributions &&
    typeof candidate.contributions === "object",
  );
}
