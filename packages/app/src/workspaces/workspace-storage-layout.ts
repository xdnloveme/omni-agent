import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { InterprocessFileLock } from "@omni-agent/core";
import { AtomicJsonFile } from "../persistence/atomic-json-file";
import { createWorkspaceId, type WorkspaceContext } from "./workspace-context";
import {
  assertWorkspaceManifest,
  createWorkspaceManifest,
  type WorkspaceManifest,
} from "./workspace-manifest";

export class WorkspaceStorageLayout {
  readonly workspacesDirectory: string;

  constructor(readonly globalDirectory: string) {
    this.workspacesDirectory = join(globalDirectory, "workspaces");
  }

  workspaceDirectory(workspaceId: string): string {
    assertWorkspaceId(workspaceId);
    return join(this.workspacesDirectory, workspaceId);
  }

  manifestPath(workspaceId: string): string {
    return join(this.workspaceDirectory(workspaceId), "workspace.json");
  }

  sessionsRoot(workspaceId: string): string {
    return join(this.workspaceDirectory(workspaceId), "sessions");
  }

  initializationLockPath(workspaceId: string): string {
    assertWorkspaceId(workspaceId);
    return join(this.workspacesDirectory, ".locks", `${workspaceId}.lock`);
  }

  async ensureInitialized(context: WorkspaceContext): Promise<void> {
    assertWorkspaceContext(context);
    const lock = new InterprocessFileLock(this.initializationLockPath(context.id));
    await lock.runExclusive(async () => {
      await mkdir(this.workspaceDirectory(context.id), { recursive: true, mode: 0o700 });
      const manifestFile = new AtomicJsonFile<WorkspaceManifest>(this.manifestPath(context.id));
      const current = await manifestFile.read();
      if (current !== undefined) {
        assertWorkspaceManifest(current, context);
        return;
      }
      await manifestFile.write(createWorkspaceManifest(context));
    });
  }
}

function assertWorkspaceContext(context: WorkspaceContext): void {
  assertWorkspaceId(context.id);
  if (createWorkspaceId(context.root) !== context.id) {
    throw new Error(`Workspace context id does not match root: ${context.root}`);
  }
}

function assertWorkspaceId(workspaceId: string): void {
  if (!/^[a-f0-9]{64}$/.test(workspaceId)) throw new Error(`Invalid workspace id: ${workspaceId}`);
}
