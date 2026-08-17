import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createWorkspaceId,
  normalizeWorkspaceRoot,
  resolveWorkspaceContext,
  WorkspaceStorageLayout,
} from "../workspaces/index";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

describe("workspace context", () => {
  it("uses the nearest Git root for nested directories and .git files", async () => {
    const root = await temporaryDirectory("omni-workspace-");
    const nested = join(root, "packages", "app");
    await mkdir(nested, { recursive: true });
    await writeFile(join(root, ".git"), "gitdir: /tmp/example\n");

    const canonicalRoot = await realpath(root);
    await expect(resolveWorkspaceContext(nested)).resolves.toEqual({
      id: createWorkspaceId(canonicalRoot),
      root: canonicalRoot,
    });
  });

  it("uses the canonical current directory outside Git repositories", async () => {
    const root = await temporaryDirectory("omni-workspace-plain-");
    const linkRoot = await temporaryDirectory("omni-workspace-link-");
    const link = join(linkRoot, "project");
    await symlink(root, link);

    expect(await resolveWorkspaceContext(link)).toEqual(await resolveWorkspaceContext(root));
  });

  it("normalizes Windows paths and creates stable full SHA-256 ids", () => {
    expect(normalizeWorkspaceRoot("C:\\Work\\Repo", "win32")).toBe("c:/Work/Repo");
    expect(createWorkspaceId("/repo")).toMatch(/^[a-f0-9]{64}$/);
    expect(createWorkspaceId("/repo")).toBe(createWorkspaceId("/repo"));
  });
});

describe("WorkspaceStorageLayout", () => {
  it("initializes one validated manifest under the workspace lock", async () => {
    const globalDirectory = await temporaryDirectory("omni-global-");
    const root = await temporaryDirectory("omni-project-");
    const context = { id: createWorkspaceId(root), root };
    const layout = new WorkspaceStorageLayout(globalDirectory);

    await Promise.all([layout.ensureInitialized(context), layout.ensureInitialized(context)]);

    expect(JSON.parse(await readFile(layout.manifestPath(context.id), "utf8"))).toEqual({
      version: 1,
      id: context.id,
      root,
    });
    expect(layout.sessionsRoot(context.id)).toBe(
      join(globalDirectory, "workspaces", context.id, "sessions"),
    );
    if (process.platform !== "win32") {
      expect((await stat(layout.workspaceDirectory(context.id))).mode & 0o777).toBe(0o700);
      expect((await stat(layout.manifestPath(context.id))).mode & 0o777).toBe(0o600);
    }
  });

  it("fails closed when an existing manifest conflicts", async () => {
    const globalDirectory = await temporaryDirectory("omni-global-");
    const root = await temporaryDirectory("omni-project-");
    const context = { id: createWorkspaceId(root), root };
    const layout = new WorkspaceStorageLayout(globalDirectory);
    await mkdir(layout.workspaceDirectory(context.id), { recursive: true });
    await writeFile(
      layout.manifestPath(context.id),
      JSON.stringify({ version: 1, id: context.id, root: "/different" }),
    );

    await expect(layout.ensureInitialized(context)).rejects.toThrow("Workspace manifest conflicts");
  });

  it("rejects a Workspace ID that was derived from another root", async () => {
    const globalDirectory = await temporaryDirectory("omni-global-");
    const firstRoot = await temporaryDirectory("omni-project-first-");
    const secondRoot = await temporaryDirectory("omni-project-second-");
    const layout = new WorkspaceStorageLayout(globalDirectory);

    await expect(
      layout.ensureInitialized({ id: createWorkspaceId(firstRoot), root: secondRoot }),
    ).rejects.toThrow("Workspace context id does not match root");
  });
});
