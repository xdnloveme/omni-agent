import { canonicalizeToolPath } from "./normalize-path";
import { isWithinPath } from "./path-boundary";
import { classifySensitivePath, type SensitivePathKind } from "./sensitive-paths";

export interface PathSecurityInspection {
  target: string;
  inWorkspace: boolean;
  sensitive: SensitivePathKind;
}

export async function inspectPathSecurity(
  value: string,
  cwd: string,
): Promise<PathSecurityInspection> {
  const [target, workspace] = await Promise.all([
    canonicalizeToolPath(value, cwd),
    canonicalizeToolPath(cwd, cwd),
  ]);
  return {
    target,
    inWorkspace: isWithinPath(target, workspace),
    sensitive: classifySensitivePath(target),
  };
}
