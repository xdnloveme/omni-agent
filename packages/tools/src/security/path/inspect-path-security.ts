import { resolveCanonicalPath, type CanonicalPathKind } from "./normalize-path";
import { isWithinPath } from "./path-boundary";
import {
  classifySensitivePath,
  type PathSecurityEnvironment,
  type PathSensitivity,
} from "./sensitive-paths";

export type PathTargetKind = CanonicalPathKind;

export interface PathInspectionContext {
  readonly cwd: string;
  readonly workspaceRoot: string;
}

export interface PathTargetInspection {
  target: string;
  sensitivity: PathSensitivity;
  targetKind: PathTargetKind;
}

export interface PathSecurityInspection extends PathTargetInspection {
  inWorkspace: boolean;
}

export async function inspectPathTarget(
  value: string,
  cwd: string,
  environment: PathSecurityEnvironment,
): Promise<PathTargetInspection> {
  const resolution = await resolveCanonicalPath(value, cwd);
  return { ...resolution, sensitivity: classifySensitivePath(resolution.target, environment) };
}

export async function inspectPathSecurity(
  value: string,
  context: PathInspectionContext,
  environment: PathSecurityEnvironment,
): Promise<PathSecurityInspection> {
  // Execution cwd resolves the target; only the injected root determines workspace membership.
  const [resolution, workspace] = await Promise.all([
    inspectPathTarget(value, context.cwd, environment),
    resolveCanonicalPath(context.workspaceRoot, context.workspaceRoot),
  ]);
  return {
    ...resolution,
    inWorkspace: isWithinPath(resolution.target, workspace.target, environment.platform),
  };
}
