import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GodotExecutableError, resolveGodotExecutable } from "./godot-executable-resolver";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Godot executable resolver", () => {
  it("uses an explicit 4.7.2 executable without exposing it through a fallback", async () => {
    const directory = await temporaryDirectory();
    const executable = await fakeGodot(directory, "4.7.2.stable.official");

    await expect(
      resolveGodotExecutable({
        cwd: directory,
        platform: "darwin",
        environment: { OMNI_GODOT_BINARY: executable, PATH: "" },
      }),
    ).resolves.toBe(executable);
  });

  it("fails closed when the configured Godot version does not match", async () => {
    const directory = await temporaryDirectory();
    const executable = await fakeGodot(directory, "4.7.1.stable.official");

    await expect(
      resolveGodotExecutable({
        cwd: directory,
        platform: "linux",
        environment: { OMNI_GODOT_BINARY: executable, PATH: "" },
      }),
    ).rejects.toMatchObject({
      code: "godot_version_mismatch",
    } satisfies Partial<GodotExecutableError>);
  });

  it("reports the explicit setup requirement when no executable exists", async () => {
    const directory = await temporaryDirectory();

    await expect(
      resolveGodotExecutable({
        cwd: directory,
        platform: "linux",
        environment: { PATH: "" },
      }),
    ).rejects.toMatchObject({ code: "godot_not_found" } satisfies Partial<GodotExecutableError>);
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "omni-godot-resolver-"));
  temporaryDirectories.push(path);
  return path;
}

async function fakeGodot(directory: string, version: string): Promise<string> {
  const path = join(directory, "godot");
  await writeFile(path, `#!/bin/sh\nprintf '${version}\\n'\n`, "utf8");
  await chmod(path, 0o755);
  return path;
}
