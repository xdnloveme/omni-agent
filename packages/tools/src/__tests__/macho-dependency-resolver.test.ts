import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DarwinDeveloperToolRuntimeResolver } from "../process/executable/platform/macos/developer-tool-runtime-resolver";
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
          sections: [],
        },
      ],
      [
        canonicalLoader,
        {
          dependencies: ["@executable_path/libExecutable.dylib"],
          rpaths: [],
          sections: [],
        },
      ],
      [canonicalExecutableRelative, { dependencies: [], rpaths: [], sections: [] }],
      [canonicalRpath, { dependencies: [], rpaths: [], sections: [] }],
    ]);
    let inspectedImages = 0;
    let inspectionCalls = 0;
    const resolver = new DarwinMachODependencyResolver({
      inspect: async (image) => {
        inspectionCalls += 1;
        const inspection = inspections.get(image);
        if (!inspection) throw new Error(`unexpected image: ${image}`);
        return inspection;
      },
    });
    const result = await resolver.resolve(canonicalExecutable, {
      rootExecutablePath: canonicalExecutable,
      consumeImageBudget: () => {
        inspectedImages += 1;
      },
    });

    expect(result).toEqual(
      [canonicalLoader, canonicalRpath, canonicalExecutableRelative].map((dependency) => ({
        path: dependency,
        scope: "exact",
      })),
    );
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
    const resolver = new DarwinMachODependencyResolver({
      inspect: async () => ({
        dependencies: ["/opt/missing/libMissing.dylib"],
        rpaths: [],
        sections: [],
      }),
    });
    await expect(
      resolver.resolve(executable, {
        rootExecutablePath: executable,
        consumeImageBudget() {},
      }),
    ).rejects.toMatchObject({ code: "sandbox_runtime_dependency_unresolved" });
  });

  it("projects the current developer-tool root without caching selector changes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "omni-developer-tool-"));
    temporaryDirectories.push(root);
    const executable = path.join(root, "tool");
    const home = path.join(root, "home");
    const firstDeveloperRoot = path.join(root, "Xcode-A", "Contents", "Developer");
    const secondDeveloperRoot = path.join(root, "Xcode-B", "Contents", "Developer");
    const lexicalSelector = path.join(root, "var", "select", "developer_dir");
    const canonicalSelector = path.join(root, "private", "var", "select", "developer_dir");
    await Promise.all([
      writeFile(executable, ""),
      mkdir(home),
      mkdir(firstDeveloperRoot, { recursive: true }),
      mkdir(secondDeveloperRoot, { recursive: true }),
      mkdir(path.dirname(lexicalSelector), { recursive: true }),
      mkdir(path.dirname(canonicalSelector), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(path.dirname(firstDeveloperRoot), "Info.plist"), ""),
      writeFile(path.join(path.dirname(secondDeveloperRoot), "Info.plist"), ""),
    ]);
    await Promise.all([
      symlink(firstDeveloperRoot, lexicalSelector),
      symlink(firstDeveloperRoot, canonicalSelector),
    ]);
    const snapshot = {
      platform: "darwin" as const,
      path: "/usr/bin:/bin",
      pathEntries: [],
      pathExtensions: [""],
      home,
    };
    const resolver = new DarwinMachODependencyResolver({
      inspect: async () => ({
        dependencies: ["/usr/lib/libxcselect.dylib"],
        rpaths: [],
        sections: ["__DATA,__xcrun_shim"],
      }),
      developerTools: new DarwinDeveloperToolRuntimeResolver(snapshot, {
        lexical: lexicalSelector,
        canonical: canonicalSelector,
      }),
    });
    const context = {
      rootExecutablePath: executable,
      consumeImageBudget() {},
    };

    const first = await resolver.resolve(executable, context);
    expect(first).toContainEqual({
      path: await realpath(path.dirname(firstDeveloperRoot)),
      scope: "subtree",
    });

    await Promise.all([rm(lexicalSelector), rm(canonicalSelector)]);
    await Promise.all([
      symlink(secondDeveloperRoot, lexicalSelector),
      symlink(secondDeveloperRoot, canonicalSelector),
    ]);
    const second = await resolver.resolve(executable, context);
    expect(second).toContainEqual({
      path: await realpath(path.dirname(secondDeveloperRoot)),
      scope: "subtree",
    });
    expect(second).not.toContainEqual({
      path: await realpath(path.dirname(firstDeveloperRoot)),
      scope: "subtree",
    });

    const configured = await new DarwinDeveloperToolRuntimeResolver(
      { ...snapshot, developerDirectory: secondDeveloperRoot },
      { lexical: lexicalSelector, canonical: canonicalSelector },
    ).resolve({
      dependencies: ["/usr/lib/libxcselect.dylib"],
      rpaths: [],
      sections: ["__DATA,__xcrun_shim"],
    });
    expect(configured).not.toContainEqual({
      path: path.dirname(lexicalSelector),
      scope: "subtree",
    });
    expect(configured).toContainEqual({
      path: await realpath(path.dirname(secondDeveloperRoot)),
      scope: "subtree",
    });
  });
});
