import { constants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { throwIfAborted } from "@omni-agent/core";
import { SandboxProcessError } from "../sandbox-process-error";
import type { HostRuntimeSnapshot, ResolvedExecutable } from "./types";

const MAX_PATH_LENGTH = 4096;

/** Performs host lookup only. Authorization belongs to ExecutableTrustPolicy. */
export async function findExecutable(
  command: string,
  cwd: string,
  snapshot: HostRuntimeSnapshot,
  signal?: AbortSignal,
): Promise<ResolvedExecutable> {
  throwIfAborted(signal);
  if (!command || command.length > MAX_PATH_LENGTH || command.includes("\0")) {
    throw executableNotFound(command);
  }
  if (hasPathSeparator(command, snapshot.platform)) {
    const candidate = path.isAbsolute(command)
      ? path.normalize(command)
      : path.resolve(cwd, command);
    return { ...(await inspectExecutable(candidate, signal)), lookupSource: "explicit_path" };
  }

  for (const entry of snapshot.pathEntries) {
    throwIfAborted(signal);
    const directory = entry.kind === "absolute" ? entry.path : path.resolve(cwd, entry.path);
    for (const extension of snapshot.pathExtensions) {
      const candidate = path.join(directory, withExtension(command, extension, snapshot.platform));
      try {
        return {
          ...(await inspectExecutable(candidate, signal)),
          pathEntry: directory,
          lookupSource: entry.kind === "absolute" ? "immutable_path" : "relative_path",
        };
      } catch (error) {
        if (!isMissingOrNotExecutable(error)) throw error;
      }
    }
  }
  throw executableNotFound(command);
}

async function inspectExecutable(
  candidate: string,
  signal?: AbortSignal,
): Promise<Omit<ResolvedExecutable, "pathEntry" | "lookupSource">> {
  throwIfAborted(signal);
  const file = await lstat(candidate);
  if (!file.isFile() && !file.isSymbolicLink()) throw notExecutable();
  await access(candidate, constants.X_OK);
  const canonicalExecutablePath = await realpath(candidate);
  const target = await lstat(canonicalExecutablePath);
  if (!target.isFile()) throw notExecutable();
  return { executablePath: path.resolve(candidate), canonicalExecutablePath };
}

function notExecutable(): NodeJS.ErrnoException {
  const error = new Error("not an executable file") as NodeJS.ErrnoException;
  error.code = "EACCES";
  return error;
}

function hasPathSeparator(command: string, platform: NodeJS.Platform): boolean {
  return command.includes("/") || (platform === "win32" && command.includes("\\"));
}

function withExtension(command: string, extension: string, platform: NodeJS.Platform): string {
  if (platform !== "win32" || path.extname(command)) return command;
  return `${command}${extension}`;
}

function isMissingOrNotExecutable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "EACCES";
}

function executableNotFound(command: string): SandboxProcessError {
  return new SandboxProcessError(
    "process_executable_not_found",
    `Executable is unavailable in the trusted runtime PATH: ${safeCommandLabel(command)}`,
  );
}

function safeCommandLabel(command: string): string {
  return (
    path
      .basename(command)
      .replace(/[\x00-\x1f\x7f]/g, "")
      .slice(0, 128) || "(empty)"
  );
}
