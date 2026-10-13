import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostProcessSupervisor } from "./host-process-supervisor";

const directories: string[] = [];

afterEach(async () => {
  delete process.env.LARK_TEST_SECRET;
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("HostProcessSupervisor", () => {
  it("waits for an in-flight attached connection to close during disposal", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    let connectionClosed!: Promise<void>;
    const hello = new Promise<void>((resolve) =>
      server.once("connection", (socket) => {
        connectionClosed = new Promise<void>((closed) => socket.once("close", () => closed()));
        socket.once("message", () => resolve());
      }),
    );
    const supervisor = new HostProcessSupervisor({
      mode: "attached",
      port: address.port,
      token: "x".repeat(40),
    });
    try {
      const starting = supervisor.getClient();
      const rejected = expect(starting).rejects.toThrow();
      await hello;
      const closing = supervisor.dispose();
      expect(supervisor.dispose()).toBe(closing);
      await closing;
      await rejected;
      await connectionClosed;
      await expect(supervisor.getClient()).rejects.toThrow("closing");
    } finally {
      await supervisor.dispose();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("reaps a managed child when disposed before its ready record", async () => {
    const directory = await mkdtemp(join(tmpdir(), "omni-im-start-stop-"));
    directories.push(directory);
    const entryPath = join(directory, "waiting-host.mjs");
    const observationPath = join(directory, "pid.txt");
    await writeFile(
      entryPath,
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(observationPath)}, String(process.pid)); setInterval(() => {}, 1000);`,
    );
    const supervisor = new HostProcessSupervisor({
      mode: "managed",
      entryPath,
      projectDirectory: directory,
      stateDirectory: join(directory, "state"),
      agentId: "coding",
    });
    const starting = supervisor.getClient();
    const rejected = expect(starting).rejects.toThrow();
    try {
      let pid = 0;
      await vi.waitFor(async () => {
        pid = Number(await readFile(observationPath, "utf8"));
        expect(pid).toBeGreaterThan(0);
      });
      await supervisor.dispose();
      await rejected;
      await waitForProcessExit(pid);
    } finally {
      await supervisor.dispose();
    }
  });

  it("cancels restart backoff without spawning another child", async () => {
    const directory = await mkdtemp(join(tmpdir(), "omni-im-backoff-"));
    directories.push(directory);
    const entryPath = join(directory, "crashing-host.mjs");
    const launchesPath = join(directory, "launches.txt");
    await writeFile(
      entryPath,
      `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(launchesPath)}, "launch\\n"); process.exit(1);`,
    );
    const supervisor = new HostProcessSupervisor({
      mode: "managed",
      entryPath,
      projectDirectory: directory,
      stateDirectory: join(directory, "state"),
      agentId: "coding",
    });
    try {
      await expect(supervisor.getClient()).rejects.toThrow("exited before ready");
      const restarting = supervisor.getClient();
      const rejected = expect(restarting).rejects.toThrow();
      await supervisor.dispose();
      await rejected;
      expect(await readFile(launchesPath, "utf8")).toBe("launch\n");
    } finally {
      await supervisor.dispose();
    }
  });

  it("starts an authenticated managed Host without leaking gateway secrets or leaving a child", async () => {
    const directory = await mkdtemp(join(tmpdir(), "omni-im-supervisor-"));
    directories.push(directory);
    const entryPath = join(directory, "fake-host.mjs");
    const observationPath = join(directory, "observation.json");
    const wsPath = createRequire(import.meta.url).resolve("ws");
    await writeFile(entryPath, fakeHostSource(wsPath, observationPath));
    process.env.LARK_TEST_SECRET = "must-not-leak";
    const supervisor = new HostProcessSupervisor({
      mode: "managed",
      entryPath,
      projectDirectory: directory,
      stateDirectory: join(directory, "state"),
      agentId: "coding",
    });

    const client = await supervisor.getClient();
    const result = await client.request({ v: 2, id: "list", type: "list_agents" });
    expect(result).toMatchObject({ kind: "agents", agents: [{ id: "coding" }] });
    const observation = JSON.parse(await readFile(observationPath, "utf8")) as {
      readonly pid: number;
      readonly environment: readonly string[];
    };
    expect(observation.environment).not.toContain("LARK_TEST_SECRET");

    await supervisor.dispose();

    await expect(waitForProcessExit(observation.pid)).resolves.toBeUndefined();
  });
});

function fakeHostSource(wsPath: string, observationPath: string): string {
  return `
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
const { WebSocketServer } = createRequire(import.meta.url)(${JSON.stringify(wsPath)});
await writeFile(${JSON.stringify(observationPath)}, JSON.stringify({
  pid: process.pid,
  environment: Object.keys(process.env),
}));
const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
server.on("connection", (socket) => {
  let authenticated = false;
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString());
    if (!authenticated) {
      authenticated = true;
      socket.send(JSON.stringify({ v: 2, type: "ready", connectionId: "fake" }));
      return;
    }
    if (message.type === "list_agents") {
      socket.send(JSON.stringify({
        v: 2,
        type: "result",
        id: message.id,
        result: {
          kind: "agents",
          agents: [{
            id: "coding",
            displayName: "Coding",
            description: "Coding Agent",
            packageName: "@test/coding",
            packageVersion: "1.0.0"
          }]
        }
      }));
    }
  });
  socket.once("close", () => server.close(() => process.exit(0)));
});
server.once("listening", () => {
  const address = server.address();
  process.stdout.write(JSON.stringify({
    type: "agent_host_ready",
    version: 2,
    host: "127.0.0.1",
    port: address.port
  }) + "\\n");
});
process.once("SIGTERM", () => server.close(() => process.exit(0)));
`;
}

async function waitForProcessExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Managed Host process ${pid} did not exit`);
}
