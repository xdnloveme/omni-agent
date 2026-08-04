import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { loadLocalEnv } from "./local-env";

const defaultLocalExtensionPath = ".omni-agent.local/register.mjs";

function getLocalExtensionPaths(): string[] {
  loadLocalEnv();

  const paths = [
    process.env.OMNI_MODEL_EXTENSION_FILE,
    resolve(process.cwd(), defaultLocalExtensionPath),
  ].filter((path): path is string => Boolean(path));

  return Array.from(new Set(paths));
}

export async function loadLocalModelExtensions(): Promise<void> {
  for (const path of getLocalExtensionPaths()) {
    if (!existsSync(path)) continue;

    try {
      await import(pathToFileURL(path).href);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to load local model extension ${path}: ${message}`);
    }
  }
}
