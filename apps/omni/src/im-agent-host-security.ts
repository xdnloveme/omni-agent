import { mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  ExecutionSettingsRepository,
  ExecutionSettingsService,
  resolveWorkspaceContext,
  type WorkspaceContext,
} from "@omni-agent/app";

export interface ImAgentHostSecurityProfile {
  readonly projectDirectory: string;
  readonly stateDirectory: string;
  readonly configurationCwd: string;
  readonly workspace: WorkspaceContext;
}

export async function prepareImAgentHostSecurityProfile(input: {
  readonly projectDirectory: string;
  readonly stateDirectory: string;
  readonly agentId: string;
}): Promise<ImAgentHostSecurityProfile> {
  const projectDirectory = await realpath(input.projectDirectory);
  const workspace = await resolveWorkspaceContext(projectDirectory);
  const workspaceRoot = await realpath(workspace.root);
  if (workspaceRoot !== projectDirectory) {
    throw new Error(
      `OMNI_IM_PROJECT_DIRECTORY must be the resolved workspace root: ${workspaceRoot}`,
    );
  }
  const requestedStateDirectory = resolve(input.stateDirectory);
  await mkdir(requestedStateDirectory, { recursive: true, mode: 0o700 });
  const stateDirectory = await realpath(requestedStateDirectory);
  const stateFromWorkspace = relative(workspaceRoot, stateDirectory);
  if (
    stateFromWorkspace === "" ||
    (!stateFromWorkspace.startsWith("..") && !isAbsolute(stateFromWorkspace))
  ) {
    throw new Error("OMNI_IM_STATE_DIRECTORY must resolve outside the Agent-writable workspace");
  }
  const configurationCwd = join(stateDirectory, "configuration");
  await mkdir(configurationCwd, { recursive: true, mode: 0o700 });
  const settings = new ExecutionSettingsService(new ExecutionSettingsRepository(stateDirectory));
  await settings.setMode(workspace.id, input.agentId, "controlled");
  await settings.setControlledNetworkEnabled(workspace.id, input.agentId, false);
  await settings.clearApprovedFilesystemRoots(workspace.id, input.agentId);
  return {
    projectDirectory,
    stateDirectory,
    configurationCwd,
    workspace,
  };
}
