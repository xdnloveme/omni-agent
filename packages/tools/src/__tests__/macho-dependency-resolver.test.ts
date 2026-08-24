import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DarwinMachODependencyResolver } from "../process/executable/platform/macos/macho-dependency-resolver";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("DarwinMachODependencyResolver", () => {
  it("resolves loader, executable, and rpath dependencies as one closure", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "omni-macho-"));
    temporaryDirectories.push(root);
    const bin = path.join(root, "bin");
    const lib = path.join(root, "lib");
    await Promise.all([mkdir(bin), mkdir(lib)]);
    const executable = path.join(bin, "tool");
    const loader = path.join(bin, "libLoader.dylib");
    const executableRelative = path.join(bin, "libExecutable.dylib");
    const rpath = path.join(lib, "libRpath.dylib");
    await Promise.all(
      [executable, loader, executableRelative, rpath].map((file) => writeFile(file, "")),
    );
    const [canonicalExecutable, canonicalLoader, canonicalExecutableRelative, canonicalRpath] =
      await Promise.all(
        [executable, loader, executableRelative, rpath].map((file) => realpath(file)),
      );

    const inspections = new Map([
      [
        canonicalExecutable,
        {
          dependencies: ["@loader_path/libLoader.dylib", "@rpath/libRpath.dylib"],
          rpaths: ["@loader_path/../lib"],
        },
      ],
      [
        canonicalLoader,
        {
          dependencies: ["@executable_path/libExecutable.dylib"],
          rpaths: [],
        },
      ],
      [canonicalExecutableRelative, { dependencies: [], rpaths: [] }],
      [canonicalRpath, { dependencies: [], rpaths: [] }],
    ]);
    let inspectedImages = 0;
    let inspectionCalls = 0;
    const resolver = new DarwinMachODependencyResolver(async (image) => {
      inspectionCalls += 1;
      const inspection = inspections.get(image);
      if (!inspection) throw new Error(`unexpected image: ${image}`);
      return inspection;
    });
    const result = await resolver.resolve(canonicalExecutable, {
      rootExecutablePath: canonicalExecutable,
      consumeImageBudget: () => {
        inspectedImages += 1;
      },
    });

    expect(result).toEqual([canonicalLoader, canonicalRpath, canonicalExecutableRelative]);
    expect(inspectedImages).toBe(4);
    await resolver.resolve(canonicalExecutable, {
      rootExecutablePath: canonicalExecutable,
      consumeImageBudget() {},
    });
    expect(inspectionCalls).toBe(4);

    await writeFile(canonicalLoader, "changed");
    await resolver.resolve(canonicalExecutable, {
      rootExecutablePath: canonicalExecutable,
      consumeImageBudget() {},
    });
    expect(inspectionCalls).toBe(5);
  });

  it("fails when a non-system dependency cannot be resolved", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "omni-macho-missing-"));
    temporaryDirectories.push(root);
    const executable = path.join(root, "tool");
    await writeFile(executable, "");
    const resolver = new DarwinMachODependencyResolver(async () => ({
      dependencies: ["/opt/missing/libMissing.dylib"],
      rpaths: [],
    }));
    await expect(
      resolver.resolve(executable, {
        rootExecutablePath: executable,
        consumeImageBudget() {},
      }),
    ).rejects.toMatchObject({ code: "sandbox_runtime_dependency_unresolved" });
  });
});
