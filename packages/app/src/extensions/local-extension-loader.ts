import { existsSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentExtension, ExtensionDiagnostic } from "./types";

export interface LocalExtensionLoadResult {
  extensions: Array<{ extension: AgentExtension; source: string }>;
  diagnostics: ExtensionDiagnostic[];
}

export async function loadLocalAgentExtensions(cwd = process.cwd()): Promise<LocalExtensionLoadResult> {
  const configured = (process.env.OMNI_AGENT_EXTENSION_FILES ?? "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const paths = [...new Set([
    ...configured.map((entry) => resolve(cwd, entry)),
    resolve(cwd, ".omni-agent.local/extensions.mjs"),
  ])];
  const result: LocalExtensionLoadResult = { extensions: [], diagnostics: [] };

  for (const path of paths) {
    if (!existsSync(path)) continue;
    try {
      const loaded = await import(pathToFileURL(path).href) as { default?: unknown };
      const values = Array.isArray(loaded.default) ? loaded.default : [loaded.default];
      for (const value of values) {
        if (!isAgentExtension(value)) throw new Error("Default export must be an AgentExtension or AgentExtension[]");
        result.extensions.push({ extension: value, source: path });
      }
    } catch (error) {
      result.diagnostics.push({
        extensionId: "unknown",
        source: path,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}

function isAgentExtension(value: unknown): value is AgentExtension {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AgentExtension>;
  return Boolean(
    candidate.manifest
    && typeof candidate.manifest.id === "string"
    && candidate.manifest.apiVersion === 1
    && candidate.contributions
    && typeof candidate.contributions === "object",
  );
}
