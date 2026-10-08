import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ExecutionSettingsRepository,
  ExecutionSettingsService,
  resolveWorkspaceContext,
} from "@omni-agent/app";
import { afterEach, describe, expect, it } from "vitest";
import { prepareImAgentHostSecurityProfile } from "./im-agent-host-security";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("prepareImAgentHostSecurityProfile", () => {
  it("rejects a state-directory symbolic link into the workspace", async () => {
    const root = await createDirectory();
    const projectDirectory = join(root, "project");
    const stateLink = join(root, "state");
    await mkdir(projectDirectory);
    await symlink(projectDirectory, stateLink);

    await expect(
      prepareImAgentHostSecurityProfile({
        projectDirectory,
        stateDirectory: stateLink,
        agentId: "coding",
      }),
    ).rejects.toThrow("must resolve outside the Agent-writable workspace");
  });

  it("converges persisted execution settings to the fixed IM safety profile", async () => {
    const root = await createDirectory();
    const projectDirectory = join(root, "project");
    const stateDirectory = join(root, "state");
    await mkdir(projectDirectory);
    await mkdir(stateDirectory);
    const workspace = await resolveWorkspaceContext(projectDirectory);
    const settings = new ExecutionSettingsService(new ExecutionSettingsRepository(stateDirectory));
    await settings.setMode(workspace.id, "coding", "unrestricted");
    await settings.addApprovedAccess(workspace.id, "coding", {
      targets: [{ scheme: "https", host: "example.com", port: 443 }],
      scopes: [{ path: root, scope: "subtree", access: "read_write" }],
    });

    await prepareImAgentHostSecurityProfile({
      projectDirectory,
      stateDirectory,
      agentId: "coding",
    });

    await expect(settings.getSettings(workspace.id, "coding")).resolves.toEqual({
      mode: "controlled",
      approvedNetworkTargets: [],
      approvedFilesystemRoots: [],
    });
  });
});

async function createDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "omni-im-host-security-"));
  directories.push(directory);
  return directory;
}
