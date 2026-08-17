import type { WorkspaceContext } from "./workspace-context";

export interface WorkspaceManifest {
  readonly version: 1;
  readonly id: string;
  readonly root: string;
}

export function createWorkspaceManifest(context: WorkspaceContext): WorkspaceManifest {
  return { version: 1, id: context.id, root: context.root };
}

export function assertWorkspaceManifest(
  value: unknown,
  expected: WorkspaceContext,
): asserts value is WorkspaceManifest {
  if (!value || typeof value !== "object") throw manifestConflict(expected);
  const manifest = value as Partial<WorkspaceManifest>;
  if (manifest.version !== 1 || manifest.id !== expected.id || manifest.root !== expected.root) {
    throw manifestConflict(expected);
  }
}

function manifestConflict(expected: WorkspaceContext): Error {
  return new Error(`Workspace manifest conflicts with resolved workspace: ${expected.root}`);
}
