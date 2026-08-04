import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const defaultLocalEnvPath = ".omni-agent.local/.env";
let loaded = false;

function parseEnvLine(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  const equals = trimmed.indexOf("=");
  if (equals <= 0) return null;

  const key = trimmed.slice(0, equals).trim();
  let value = trimmed.slice(equals + 1).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;

  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }

  return [key, value];
}

function getLocalEnvPaths(): string[] {
  const paths = [
    process.env.OMNI_LOCAL_ENV_FILE,
    resolve(process.cwd(), defaultLocalEnvPath),
  ].filter((path): path is string => Boolean(path));

  return Array.from(new Set(paths));
}

export function loadLocalEnv(): void {
  if (loaded) return;
  loaded = true;

  for (const path of getLocalEnvPaths()) {
    if (!existsSync(path)) continue;

    const lines = readFileSync(path, "utf-8").split(/\r?\n/);
    for (const line of lines) {
      const parsed = parseEnvLine(line);
      if (!parsed) continue;

      const [key, value] = parsed;
      process.env[key] ??= value;
    }
  }
}

export function expandEnv(value: string): string | null {
  loadLocalEnv();

  let missing = false;
  const expanded = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, braced, bare) => {
    const envName = String(braced ?? bare);
    const envValue = process.env[envName];
    if (envValue === undefined) {
      missing = true;
      return "";
    }
    return envValue;
  });

  return missing ? null : expanded;
}
