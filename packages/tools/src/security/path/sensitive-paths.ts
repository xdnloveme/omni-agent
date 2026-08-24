import path from "node:path";
import type { HostRuntimeContext } from "@omni-agent/core";
import { isWithinPath } from "./path-boundary";
import { normalizeForComparison } from "./normalize-path";

export interface SensitivePathPolicy {
  readonly credentialDirectories: readonly string[];
  readonly credentialFileNames: readonly string[];
  readonly credentialNamePrefixes: readonly string[];
  readonly credentialTemplateNames: readonly string[];
  readonly systemDirectories: readonly string[];
  readonly virtualSystemDirectories: readonly string[];
  readonly deviceDirectories: readonly string[];
}

export type PathSensitivity = "credential" | "system_file" | "virtual_system" | "device" | null;

export type PathSecurityEnvironment = HostRuntimeContext;

export function classifySensitivePath(
  target: string,
  environment: PathSecurityEnvironment,
): PathSensitivity {
  const normalized = normalizeForComparison(target, environment.platform);
  const basename = path.basename(normalized).toLowerCase();
  const policy = createSensitivePathPolicy(environment);
  if (
    policy.credentialDirectories.some((directory) =>
      isWithinPath(normalized, directory, environment.platform),
    )
  ) {
    return "credential";
  }
  if (!policy.credentialTemplateNames.includes(basename)) {
    if (
      policy.credentialFileNames.includes(basename) ||
      policy.credentialNamePrefixes.some((prefix) => basename.startsWith(prefix))
    ) {
      return "credential";
    }
  }
  if (
    policy.deviceDirectories.some((directory) =>
      isWithinPath(normalized, directory, environment.platform),
    )
  )
    return "device";
  if (
    policy.virtualSystemDirectories.some((directory) =>
      isWithinPath(normalized, directory, environment.platform),
    )
  ) {
    return "virtual_system";
  }
  if (
    policy.systemDirectories.some((directory) =>
      isWithinPath(normalized, directory, environment.platform),
    )
  ) {
    return "system_file";
  }
  return null;
}

export function createSensitivePathPolicy(
  environment: PathSecurityEnvironment,
): SensitivePathPolicy {
  const credentialDirectories = [
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
    credentialDirectories.push(
      path.join(environment.home, "Library", "Keychains"),
      path.join(environment.home, "Library", "Application Support", "Google", "Chrome", "Default"),
    );
  }
  return {
    credentialDirectories,
    credentialFileNames: [
      ".env",
      ".envrc",
      ".npmrc",
      ".pypirc",
      ".netrc",
      ".pgpass",
      ".my.cnf",
      ".git-credentials",
    ],
    credentialNamePrefixes: [".env."],
    credentialTemplateNames: [".env.example", ".env.sample", ".env.template", ".env.dist"],
    systemDirectories: ["/etc", "/root", "/private/etc", "/private/var/root"],
    virtualSystemDirectories: ["/proc", "/sys"],
    deviceDirectories: ["/dev"],
  };
}
