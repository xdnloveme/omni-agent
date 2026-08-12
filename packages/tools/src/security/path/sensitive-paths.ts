import os from "node:os";
import path from "node:path";
import { isWithinPath } from "./path-boundary";
import { normalizeForComparison } from "./normalize-path";

const credentialFiles = new Set([
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".pgpass",
  ".my.cnf",
  ".git-credentials",
]);
const credentialTemplates = new Set([".env.example", ".env.sample", ".env.template", ".env.dist"]);
const systemDirectories = ["/etc", "/root"];
const virtualSystemDirectories = ["/proc", "/sys"];
const deviceDirectories = ["/dev"];

export type PathSensitivity = "credential" | "system_file" | "virtual_system" | "device" | null;

export interface PathSecurityEnvironment {
  platform: NodeJS.Platform;
  home: string;
}

export function classifySensitivePath(
  target: string,
  environment: PathSecurityEnvironment = {
    platform: process.platform,
    home: os.homedir(),
  },
): PathSensitivity {
  const normalized = normalizeForComparison(target, environment.platform);
  const basename = path.basename(normalized).toLowerCase();
  const credentialDirectories = createCredentialDirectories(environment);
  if (
    credentialDirectories.some((directory) =>
      isWithinPath(normalized, directory, environment.platform),
    )
  ) {
    return "credential";
  }
  if (!credentialTemplates.has(basename)) {
    if (basename === ".env" || basename === ".envrc" || basename.startsWith(".env.")) {
      return "credential";
    }
    if (credentialFiles.has(basename)) return "credential";
  }
  if (
    deviceDirectories.some((directory) => isWithinPath(normalized, directory, environment.platform))
  )
    return "device";
  if (
    virtualSystemDirectories.some((directory) =>
      isWithinPath(normalized, directory, environment.platform),
    )
  ) {
    return "virtual_system";
  }
  if (
    systemDirectories.some((directory) => isWithinPath(normalized, directory, environment.platform))
  ) {
    return "system_file";
  }
  return null;
}

function createCredentialDirectories(environment: PathSecurityEnvironment): string[] {
  const directories = [
    ".ssh",
    ".aws",
    ".gnupg",
    ".kube",
    ".docker",
    path.join(".config", "gh"),
    path.join(".config", "gcloud"),
    ".azure",
  ].map((entry) => path.join(environment.home, entry));
  if (environment.platform === "darwin") {
    directories.push(
      path.join(environment.home, "Library", "Keychains"),
      path.join(environment.home, "Library", "Application Support", "Google", "Chrome", "Default"),
    );
  }
  return directories;
}
