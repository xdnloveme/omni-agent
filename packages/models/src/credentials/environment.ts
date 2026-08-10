import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AuthContext } from "@earendil-works/pi-ai";
import { parse } from "dotenv";

function readProjectEnvironment(cwd: string): Map<string, string> {
  const environment = new Map<string, string>();
  const paths = [
    resolve(cwd, ".env"),
    process.env.OMNI_LOCAL_ENV_FILE && resolve(cwd, process.env.OMNI_LOCAL_ENV_FILE),
    resolve(cwd, ".omni-agent.local/.env"),
  ].filter((path): path is string => Boolean(path));
  for (const path of paths) {
    if (!existsSync(path)) continue;
    for (const [key, value] of Object.entries(parse(readFileSync(path, "utf-8")))) {
      if (!environment.has(key)) environment.set(key, value);
    }
  }
  return environment;
}

export function createNodeAuthContext(cwd = process.cwd()): AuthContext {
  const projectEnvironment = readProjectEnvironment(cwd);
  return {
    env: async (name) => process.env[name] ?? projectEnvironment.get(name),
    fileExists: async (path) => {
      const expanded = path.startsWith("~/")
        ? resolve(process.env.HOME ?? cwd, path.slice(2))
        : resolve(cwd, path);
      return existsSync(expanded);
    },
  };
}
