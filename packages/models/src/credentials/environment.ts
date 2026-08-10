import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { AuthContext } from "@earendil-works/pi-ai";
import { parse } from "dotenv";

function readLayeredEnvironment(cwd: string, globalDirectory: string): Map<string, string> {
  const environment = new Map<string, string>();
  const paths = [resolve(cwd, ".env"), resolve(globalDirectory, ".env")];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    for (const [key, value] of Object.entries(parse(readFileSync(path, "utf-8")))) {
      if (!environment.has(key)) environment.set(key, value);
    }
  }
  return environment;
}

export function createNodeAuthContext(
  cwd = process.cwd(),
  globalDirectory = resolve(homedir(), ".omni-agent"),
): AuthContext {
  const layeredEnvironment = readLayeredEnvironment(cwd, globalDirectory);
  return {
    env: async (name) => process.env[name] ?? layeredEnvironment.get(name),
    fileExists: async (path) => {
      const expanded = path.startsWith("~/")
        ? resolve(process.env.HOME ?? cwd, path.slice(2))
        : resolve(cwd, path);
      return existsSync(expanded);
    },
  };
}
