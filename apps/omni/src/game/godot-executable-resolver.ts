import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";

export const REQUIRED_GODOT_VERSION = "4.7.2";
const VERSION_TIMEOUT_MS = 5_000;

export class GodotExecutableError extends Error {
  constructor(
    readonly code: "godot_not_found" | "godot_version_mismatch" | "godot_version_check_failed",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "GodotExecutableError";
  }
}

export interface GodotExecutableResolverOptions {
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}

export async function resolveGodotExecutable(
  options: GodotExecutableResolverOptions,
): Promise<string> {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const candidates = candidatePaths(options.cwd, environment, platform);

  for (const candidate of candidates) {
    if (!(await isExecutable(candidate))) continue;
    await assertGodotVersion(candidate, environment);
    return candidate;
  }

  throw new GodotExecutableError(
    "godot_not_found",
    `Godot ${REQUIRED_GODOT_VERSION} was not found. Install it or set OMNI_GODOT_BINARY.`,
  );
}

export async function assertGodotVersion(
  executable: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  let stdout: string;
  try {
    stdout = await executeVersionProbe(executable, environment);
  } catch (error) {
    throw new GodotExecutableError(
      "godot_version_check_failed",
      "Godot version could not be verified.",
      { cause: error },
    );
  }

  const version = stdout.trim();
  if (!new RegExp(`^${REQUIRED_GODOT_VERSION.replaceAll(".", "\\.")}(?:[.-]|$)`).test(version)) {
    throw new GodotExecutableError(
      "godot_version_mismatch",
      `Godot ${REQUIRED_GODOT_VERSION} is required, but ${version || "an unknown version"} was found.`,
    );
  }
}

function executeVersionProbe(executable: string, environment: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      executable,
      ["--version"],
      {
        encoding: "utf8",
        env: environment,
        timeout: VERSION_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolvePromise(stdout);
      },
    );
  });
}

function candidatePaths(
  cwd: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): readonly string[] {
  const candidates: string[] = [];
  const configured = environment.OMNI_GODOT_BINARY?.trim();
  if (configured) candidates.push(isAbsolute(configured) ? configured : resolve(cwd, configured));
  if (platform === "darwin") {
    candidates.push("/Applications/Godot.app/Contents/MacOS/Godot");
  }
  const pathEntries = (environment.PATH ?? "").split(delimiter).filter(Boolean);
  for (const executableName of ["godot", "godot4"]) {
    for (const entry of pathEntries) {
      candidates.push(join(isAbsolute(entry) ? entry : resolve(cwd, entry), executableName));
    }
  }
  return [...new Set(candidates)];
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
