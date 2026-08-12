import { resolveCanonicalPath, type CanonicalPathKind } from "./normalize-path";
import { isWithinPath } from "./path-boundary";
import {
  classifySensitivePath,
  type PathSecurityEnvironment,
  type PathSensitivity,
} from "./sensitive-paths";

export type PathTargetKind = CanonicalPathKind;

export interface PathSecurityInspection {
  target: string;
  inWorkspace: boolean;
  sensitivity: PathSensitivity;
  targetKind: PathTargetKind;
}

export async function inspectPathSecurity(
  value: string,
  cwd: string,
  environment?: PathSecurityEnvironment,
): Promise<PathSecurityInspection> {
  const [resolution, workspace] = await Promise.all([
    resolveCanonicalPath(value, cwd),
    resolveCanonicalPath(cwd, cwd),
  ]);
  return {
    target: resolution.target,
    targetKind: resolution.targetKind,
    inWorkspace: isWithinPath(resolution.target, workspace.target, environment?.platform),
    sensitivity: classifySensitivePath(resolution.target, environment),
  };
}
