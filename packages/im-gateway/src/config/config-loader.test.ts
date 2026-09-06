import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { loadGatewayConfig, readBotEnvironment } from "./config-loader";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("loadGatewayConfig", () => {
  it("rejects a state directory whose symbolic-link target is Agent-writable", async () => {
    const root = await createDirectory();
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    await mkdir(workspace);
    await mkdir(outside);
    await symlink(workspace, join(outside, "state-link"));
    const path = await writeConfig(root, workspace, join(outside, "state-link", "bot"));

    await expect(loadGatewayConfig(path)).rejects.toThrow(
      "must be outside the Agent-writable workspace",
    );
  });

  it("loads valid bots independently of runtime credentials", async () => {
    const root = await createDirectory();
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const path = await writeConfig(root, workspace, join(root, "state", "bot"));

    const config = await loadGatewayConfig(path);

    expect(config.bots).toHaveLength(1);
    expect(() => readBotEnvironment(config.bots[0]!, {})).toThrow(
      "Environment variable TEST_LARK_SECRET is required for bot coding",
    );
  });

  it("rejects a configuration file inside an Agent-writable workspace", async () => {
    const root = await createDirectory();
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const path = await writeConfig(workspace, workspace, join(root, "state", "bot"));

    await expect(loadGatewayConfig(path)).rejects.toThrow(
      "gateway configuration file must be outside the Agent-writable workspace",
    );
  });

  it("rejects a gateway state file inside a bot state directory", async () => {
    const root = await createDirectory();
    const workspace = join(root, "workspace");
    const stateDirectory = join(root, "state", "bot");
    await mkdir(workspace);
    const path = await writeConfig(root, workspace, stateDirectory, {
      stateFile: join(stateDirectory, "gateway.json"),
    });

    await expect(loadGatewayConfig(path)).rejects.toThrow(
      "IM gateway state file must not overlap bot state directory",
    );
  });
});

async function createDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "omni-im-config-"));
  directories.push(directory);
  return directory;
}

async function writeConfig(
  root: string,
  projectDirectory: string,
  stateDirectory: string,
  overrides: { readonly stateFile?: string } = {},
): Promise<string> {
  const path = join(root, "omni.im.json");
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      stateFile: overrides.stateFile ?? join(root, "gateway.json"),
      bots: [
        {
          id: "coding",
          agentId: "coding",
          projectDirectory,
          stateDirectory,
          allowUsers: ["ou_allowed"],
          concurrency: "concurrent",
          lark: {
            appId: "cli_test",
            appSecretEnv: "TEST_LARK_SECRET",
          },
          host: {
            mode: "managed",
          },
        },
      ],
    }),
  );
  return path;
}
