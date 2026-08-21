import { readFile, mkdir, rm, writeFile, copyFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { builtinModules, createRequire } from "node:module";
import { build, type Metafile, type Plugin } from "esbuild";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const outputDirectory = join(repositoryRoot, "artifacts", "package");
const allowedExternals = new Set(["keytar", "tree-sitter", "tree-sitter-bash"]);
const nodeBuiltins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const optionalRuntimeModules = new Set(["bufferutil", "supports-color", "utf-8-validate"]);

export async function buildCliDistribution(): Promise<{
  readonly outputDirectory: string;
  readonly version: string;
}> {
  const cliPackage = await readJson(join(repositoryRoot, "packages", "cli", "package.json"));
  const nativeDependencies = {
    keytar: await installedVersion(
      join(repositoryRoot, "packages", "models", "package.json"),
      "keytar",
    ),
    "tree-sitter": await installedVersion(
      join(repositoryRoot, "packages", "tools", "package.json"),
      "tree-sitter",
    ),
    "tree-sitter-bash": await installedVersion(
      join(repositoryRoot, "packages", "tools", "package.json"),
      "tree-sitter-bash",
    ),
  };

  await rm(outputDirectory, { recursive: true, force: true });
  const binDirectory = join(outputDirectory, "bin");
  await mkdir(binDirectory, { recursive: true });
  const result = await build({
    absWorkingDir: repositoryRoot,
    entryPoints: {
      "cli-entry": join(repositoryRoot, "apps", "omni", "src", "index.ts"),
    },
    outdir: outputDirectory,
    entryNames: "bin/[name]",
    chunkNames: "bin/chunks/[name]-[hash]",
    platform: "node",
    target: "node22.19",
    format: "esm",
    bundle: true,
    splitting: true,
    sourcemap: true,
    metafile: true,
    banner: {
      js: 'import { createRequire as __omniCreateRequire } from "node:module";\nconst require = __omniCreateRequire(import.meta.url);',
    },
    external: [...allowedExternals],
    plugins: [optionalRuntimeModuleStubs()],
    logLevel: "info",
  });
  assertApprovedExternals(result.metafile);
  const launcherPath = join(binDirectory, "omni.js");
  await writeFile(launcherPath, '#!/usr/bin/env node\nawait import("./cli-entry.js");\n', {
    mode: 0o755,
  });

  const distributionPackage = {
    name: cliPackage.name,
    version: cliPackage.version,
    description: "Omni Agent command-line interface",
    type: "module",
    bin: { omni: "./bin/omni.js" },
    engines: { node: ">=22.19.0" },
    dependencies: nativeDependencies,
    files: ["bin", "README.md", "LICENSE"],
  };
  await writeFile(
    join(outputDirectory, "package.json"),
    `${JSON.stringify(distributionPackage, null, 2)}\n`,
  );
  await writeFile(
    join(outputDirectory, "metafile.json"),
    `${JSON.stringify(result.metafile, null, 2)}\n`,
  );
  await copyFile(join(repositoryRoot, "README.md"), join(outputDirectory, "README.md"));
  await copyFile(join(repositoryRoot, "LICENSE"), join(outputDirectory, "LICENSE"));
  await buildBrowserAssets(join(binDirectory, "assets"));

  const textOutputs = Object.keys(result.metafile.outputs)
    .filter((path) => path.endsWith(".js") || path.endsWith(".js.map"))
    .map((path) => resolve(repositoryRoot, path));
  for (const outputPath of [launcherPath, ...textOutputs]) {
    const bundle = await readFile(outputPath, "utf8");
    for (const forbidden of ["workspace:*", repositoryRoot]) {
      if (bundle.includes(forbidden)) {
        throw new Error(`CLI bundle contains forbidden value: ${forbidden}`);
      }
    }
  }
  return { outputDirectory, version: cliPackage.version };
}

async function buildBrowserAssets(outputDirectory: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(
      "pnpm",
      [
        "--filter",
        "@omni-agent/ui",
        "exec",
        "vite",
        "build",
        "--config",
        "vite.config.ts",
        "--outDir",
        outputDirectory,
        "--emptyOutDir",
      ],
      { cwd: repositoryRoot, stdio: "inherit" },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`Vite build failed (${signal ?? code})`));
    });
  });
}

function assertApprovedExternals(metafile: Metafile): void {
  const externalImports = new Set<string>();
  for (const output of Object.values(metafile.outputs)) {
    for (const entry of output.imports) {
      if (entry.external && !entry.path.startsWith("node:") && !nodeBuiltins.has(entry.path)) {
        externalImports.add(entry.path);
      }
    }
  }
  const unexpected = [...externalImports].filter((name) => !allowedExternals.has(name));
  if (unexpected.length > 0) {
    throw new Error(`Unapproved CLI externals: ${unexpected.join(", ")}`);
  }
}

function optionalRuntimeModuleStubs(): Plugin {
  // These modules are optional performance/color enhancements in bundled dependencies.
  // Resolving them to the same falsey value used by their missing-module fallbacks keeps
  // the distributable deterministic without turning optional packages into externals.
  return {
    name: "optional-runtime-module-stubs",
    setup(buildContext) {
      buildContext.onResolve({ filter: /.*/ }, (args) => {
        if (optionalRuntimeModules.has(args.path))
          return { path: args.path, namespace: "optional" };
        return undefined;
      });
      buildContext.onLoad({ filter: /.*/, namespace: "optional" }, () => ({
        contents: "module.exports = false;",
        loader: "js",
      }));
    },
  };
}

async function installedVersion(ownerPackagePath: string, name: string): Promise<string> {
  const require = createRequire(ownerPackagePath);
  const metadata = await readJson(require.resolve(`${name}/package.json`));
  if (!/^\d+\.\d+\.\d+$/.test(metadata.version ?? "")) {
    throw new Error(`Native dependency ${name} has an invalid installed version`);
  }
  return metadata.version;
}

async function readJson(path: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(path, "utf8"));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildCliDistribution();
}
