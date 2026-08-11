import os from "node:os";
import path from "node:path";
import { isWithinPath } from "./path-boundary";
import { normalizeForComparison } from "./normalize-path";

const home = os.homedir();

const credentialDirectories = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".docker",
  path.join(".config", "gh"),
  path.join(".config", "gcloud"),
  ".azure",
].map((entry) => path.join(home, entry));

if (process.platform === "darwin") {
  credentialDirectories.push(
    path.join(home, "Library", "Keychains"),
    path.join(home, "Library", "Application Support", "Google", "Chrome", "Default"),
  );
}

const credentialFiles = new Set([
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".pgpass",
  ".my.cnf",
  ".git-credentials",
]);
const credentialTemplates = new Set([".env.example", ".env.sample", ".env.template", ".env.dist"]);
const systemDirectories = ["/etc", "/proc", "/sys", "/dev", "/root"];

export type SensitivePathKind = "credential" | "system" | null;

export function classifySensitivePath(target: string): SensitivePathKind {
  const normalized = normalizeForComparison(target);
  const basename = path.basename(normalized).toLowerCase();
  if (!credentialTemplates.has(basename)) {
    if (basename === ".env" || basename === ".envrc" || basename.startsWith(".env.")) {
      return "credential";
    }
    if (credentialFiles.has(basename)) return "credential";
    if (credentialDirectories.some((directory) => isWithinPath(normalized, directory))) {
      return "credential";
    }
  }
  if (systemDirectories.some((directory) => isWithinPath(normalized, directory))) return "system";
  return null;
}
