import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const resolveGodotExecutable = vi.hoisted(() => vi.fn());
vi.mock("./godot-executable-resolver", () => ({ resolveGodotExecutable }));
import { parseAgentHostReady, startGameBootstrap } from "./game-bootstrap";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("GameBootstrap", () => {
  it("accepts only the exact machine-readable Host ready record", () => {
    expect(
      parseAgentHostReady(
        JSON.stringify({
          type: "agent_host_ready",
          version: 2,
          host: "127.0.0.1",
          port: 43127,
        }),
      ),
    ).toEqual({ host: "127.0.0.1", port: 43127 });

    expect(() =>
      parseAgentHostReady(
        JSON.stringify({
          type: "agent_host_ready",
          version: 2,
          host: "127.0.0.1",
          port: 43127,
          token: "must-not-be-accepted",
        }),
      ),
    ).toThrow("invalid startup record");
  });

  it("does not launch the game when Agent Host fails before ready", async () => {
    const directory = await mkdtemp(join(tmpdir(), "omni-game-bootstrap-"));
    temporaryDirectories.push(directory);
    const invocationLog = join(directory, "godot-invocations.txt");
    const godot = join(directory, "godot");
    await writeFile(
      godot,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${invocationLog}'\nif [ "$1" = "--version" ]; then printf '4.7.2.stable.official\\n'; fi\n`,
      "utf8",
    );
    await chmod(godot, 0o755);
    resolveGodotExecutable.mockResolvedValueOnce(godot);

    await expect(
      startGameBootstrap({
        workspaceCwd: directory,
        repositoryRoot: directory,
        environment: { OMNI_GODOT_BINARY: godot, PATH: process.env.PATH },
      }),
    ).rejects.toThrow("Agent Host failed to start");

    expect(resolveGodotExecutable).toHaveBeenCalledOnce();
    await expect(readFile(invocationLog, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  }, 25_000);
});
