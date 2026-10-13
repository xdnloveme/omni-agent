import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GatewayConfig } from "./config/gateway-config";
import { ImGateway } from "./gateway";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("ImGateway", () => {
  it.each(["host.js", "..private/host.js"])(
    "rejects a workspace-owned Host entry: %s",
    async (entry) => {
      const root = await mkdtemp(join(tmpdir(), "omni-im-gateway-"));
      temporaryDirectories.push(root);
      const workspace = join(root, "workspace");
      const stateDirectory = join(root, "state", "bot");
      const entryPath = join(workspace, entry);
      await mkdir(dirname(entryPath), { recursive: true });
      await writeFile(entryPath, "");

      await expect(
        ImGateway.create(config(root, workspace, stateDirectory), {
          managedHostEntryPath: entryPath,
        }),
      ).rejects.toThrow("Managed IM Agent Host entry must be outside the Agent-writable workspace");
    },
  );
});

function config(root: string, projectDirectory: string, stateDirectory: string): GatewayConfig {
  return {
    version: 1,
    stateFile: join(root, "gateway.json"),
    bots: [
      {
        id: "coding",
        agentId: "coding",
        projectDirectory,
        stateDirectory,
        allowUsers: ["ou_1"],
        concurrency: "serial",
        lark: {
          appId: "cli_test",
          appSecretEnv: "LARK_SECRET",
        },
        host: { mode: "managed" },
      },
    ],
  };
}
