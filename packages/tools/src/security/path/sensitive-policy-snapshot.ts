import { createSensitivePathPolicy } from "./sensitive-paths";

export interface SensitiveReadPolicySnapshot {
  readonly deniedSubtrees: readonly string[];
  readonly deniedExactNames: readonly string[];
  readonly deniedNamePrefixes: readonly string[];
  readonly allowedTemplateNames: readonly string[];
  readonly approvedExactPaths: readonly string[];
}

export function createSensitiveReadPolicySnapshot(
  approvedExactPaths: readonly string[],
  environment: { platform: NodeJS.Platform; home: string },
): SensitiveReadPolicySnapshot {
  const policy = createSensitivePathPolicy(environment);
  return {
    deniedSubtrees: policy.credentialDirectories,
    deniedExactNames: policy.credentialFileNames,
    deniedNamePrefixes: policy.credentialNamePrefixes,
    allowedTemplateNames: policy.credentialTemplateNames,
    approvedExactPaths: [...new Set(approvedExactPaths)],
  };
}
