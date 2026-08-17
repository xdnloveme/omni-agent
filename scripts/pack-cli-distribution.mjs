import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { buildCliDistribution } from "./build-cli-distribution.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const artifactsDirectory = join(repositoryRoot, "artifacts");
const { outputDirectory, version } = await buildCliDistribution();
const tarball = join(artifactsDirectory, `omni-agent-cli-${version}.tgz`);
await rm(tarball, { force: true });

await new Promise((resolvePromise, reject) => {
  const child = spawn("pnpm", ["pack", "--pack-destination", artifactsDirectory], {
    cwd: outputDirectory,
    stdio: "inherit",
  });
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (code === 0) resolvePromise();
    else reject(new Error(`pnpm pack failed (${signal ?? code})`));
  });
});
