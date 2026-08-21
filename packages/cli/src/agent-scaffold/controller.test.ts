import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliHostServices } from "../host-services";
import { runAgentScaffold } from "./controller";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("runAgentScaffold", () => {
  it("resolves the target from the injected Host cwd", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omni-agent-scaffold-controller-"));
    directories.push(cwd);
    const stdout = vi.fn();
    const host = {
      runtime: { cwd },
      output: { stdout },
    } as unknown as CliHostServices;

    await expect(runAgentScaffold("support", "agents/support", host)).resolves.toEqual({
      exitCode: 0,
    });

    expect(
      JSON.parse(await readFile(join(cwd, "agents/support/package.json"), "utf8")),
    ).toMatchObject({ name: "@omni-agent/agent-support" });
    expect(stdout).toHaveBeenCalledWith(
      `Created Agent package support at ${join(cwd, "agents/support")}\n`,
    );
  });
});
