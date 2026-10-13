import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fakeHostSource, waitForProcessExit } from "./agent-link/host-process-fixture";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayConfig } from "./config/gateway-config";
import { ImGateway } from "./gateway";

const sdk = vi.hoisted(() => ({
  options: undefined as undefined | { onReady?: () => void },
  started: false,
  closed: false,
}));
vi.mock("@larksuiteoapi/node-sdk", () => ({
  Client: class {
    readonly im = { message: {} };
  },
  EventDispatcher: class {
    register() {
      return this;
    }
  },
  LoggerLevel: { warn: 2 },
  WSClient: class {
    constructor(options: typeof sdk.options) {
      sdk.options = options;
    }
    start() {
      sdk.started = true;
      return Promise.resolve();
    }
    close() {
      sdk.closed = true;
    }
  },
}));

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("ImGateway", () => {
  it.each(["host", "lark", "ready"])("stops and reaps its Host during %s stage", async (stage) => {
    sdk.started = false;
    sdk.closed = false;
    vi.stubEnv("LARK_SECRET", "fixture");
    const root = await mkdtemp(join(tmpdir(), "omni-gateway-lifecycle-"));
    temporaryDirectories.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const observationPath = join(root, "host.json");
    const entryPath = join(root, "host.mjs");
    await writeFile(
      entryPath,
      fakeHostSource(
        createRequire(import.meta.url).resolve("ws"),
        observationPath,
        stage !== "host",
      ),
    );
    const gateway = await ImGateway.create(config(root, workspace, join(root, "state")), {
      managedHostEntryPath: entryPath,
    });
    let pid = 0;
    try {
      const starting = gateway.start();
      expect(gateway.start()).toBe(starting);
      // Observe both outcomes immediately, so a failed assertion cannot leave an unhandled rejection.
      const outcome = starting.then(
        (value) => ({ value, error: undefined }),
        (error) => ({ value: undefined, error }),
      );
      await vi.waitFor(async () => {
        pid = JSON.parse(await readFile(observationPath, "utf8")).pid;
        expect(pid).toBeGreaterThan(0);
      });
      if (stage !== "host") await vi.waitFor(() => expect(sdk.started).toBe(true));
      if (stage === "ready") {
        sdk.options?.onReady?.();
        await expect(starting).resolves.toEqual({ activeBots: 1 });
      }
      const stopping = gateway.stop();
      expect(gateway.stop()).toBe(stopping);
      await stopping;
      if (stage !== "ready") expect((await outcome).error).toMatchObject({ name: "AbortError" });
      expect(sdk.closed).toBe(true);
      await waitForProcessExit(pid);
      await expect(gateway.start()).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      await gateway.stop();
    }
  });

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
