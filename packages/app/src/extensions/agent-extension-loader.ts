import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentExtension, ExtensionDiagnostic } from "./types";

export interface AgentExtensionLoadResult {
  extensions: Array<{ extension: AgentExtension; source: string }>;
  diagnostics: ExtensionDiagnostic[];
}

export interface AgentExtensionLoaderOptions {
  readonly cwd?: string;
  readonly globalDirectory?: string;
}

export async function loadAgentExtensions(
  options: AgentExtensionLoaderOptions = {},
): Promise<AgentExtensionLoadResult> {
  const cwd = options.cwd ?? process.cwd();
  const paths = [
    join(options.globalDirectory ?? join(homedir(), ".omni-agent"), "extensions.mjs"),
    resolve(cwd, ".omni-agent/extensions.mjs"),
  ];
  const diagnostics: ExtensionDiagnostic[] = [];
  const extensions = new Map<string, { extension: AgentExtension; source: string }>();

  for (const path of paths) {
    if (!existsSync(path)) continue;
    try {
      const loaded = (await import(pathToFileURL(path).href)) as { default?: unknown };
      const values = Array.isArray(loaded.default) ? loaded.default : [loaded.default];
      for (const value of values) {
        if (!isAgentExtension(value)) {
          throw new Error("Default export must be an AgentExtension or AgentExtension[]");
        }
        extensions.set(value.manifest.id, { extension: value, source: path });
      }
    } catch (error) {
      diagnostics.push({
        extensionId: "unknown",
        source: path,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { extensions: [...extensions.values()], diagnostics };
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
