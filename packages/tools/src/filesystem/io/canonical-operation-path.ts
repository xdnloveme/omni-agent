import { canonicalizeToolPath } from "../../security/path/normalize-path";

export function resolveCanonicalOperationPath(value: string, cwd: string): Promise<string> {
  return canonicalizeToolPath(value, cwd);
}
