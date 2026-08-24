import path from "node:path";
import type { HostPathEntry, HostRuntimeEnvironment, HostRuntimeSnapshot } from "./types";

export function createHostRuntimeSnapshot(
  environment: HostRuntimeEnvironment,
): HostRuntimeSnapshot {
  const delimiter = environment.platform === "win32" ? ";" : ":";
  const entries = new Map<string, HostPathEntry>();
  for (const rawEntry of environment.path.split(delimiter)) {
    const entry = path.normalize(rawEntry || ".");
    const value: HostPathEntry = path.isAbsolute(entry)
      ? { kind: "absolute", path: entry }
      : { kind: "cwd", path: entry };
    entries.set(`${value.kind}\0${value.path}`, Object.freeze(value));
  }
  const pathExtensions =
    environment.platform === "win32"
      ? (environment.pathExt ?? ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .map((extension) => extension.trim().toLowerCase())
          .filter(Boolean)
      : [""];
  return Object.freeze({
    platform: environment.platform,
    path: environment.path,
    pathEntries: Object.freeze([...entries.values()]),
    pathExtensions: Object.freeze([...new Set(pathExtensions)]),
    home: path.resolve(environment.home),
  });
}
