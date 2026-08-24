import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isAbortError, throwIfAborted } from "@omni-agent/core";
import { runHostProcess } from "./host-process-runner";
import { SandboxProcessError } from "./sandbox-process-error";
import { SANDBOX_PROTOCOL_VERSION } from "./sandbox-protocol";
import { VersionedFileComputationCache } from "./versioned-file-computation-cache";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

const MAX_VERSION_OUTPUT_BYTES = 4096;

type SandboxBinaryVerifier = (candidate: string, signal?: AbortSignal) => Promise<void>;

export class SandboxBinaryResolver {
  private readonly verification = new VersionedFileComputationCache<string>(8);

  constructor(
    private readonly candidates: readonly string[] = defaultCandidates(),
    private readonly verify: SandboxBinaryVerifier = verifySandboxBinary,
  ) {}

  async resolve(signal?: AbortSignal): Promise<string> {
    for (const candidate of this.candidates) {
      try {
        await access(candidate);
        throwIfAborted(signal);
      } catch {
        throwIfAborted(signal);
        continue;
      }
      try {
        return await this.verification.get(candidate, signal, async (sharedSignal) => {
          await this.verify(candidate, sharedSignal);
          return candidate;
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") continue;
        if (isAbortError(error, signal) || error instanceof SandboxProcessError) throw error;
        throw new SandboxProcessError(
          "sandbox_launch_failed",
          "The Omni sandbox binary changed while its protocol was being verified.",
        );
      }
    }
    throw new SandboxProcessError(
      "sandbox_unavailable",
      "The Omni sandbox binary is unavailable for this installation.",
    );
  }
}

function defaultCandidates(): readonly string[] {
  return [
    process.env.OMNI_SANDBOX_BINARY,
    path.join(repositoryRoot, "sandbox", "target", "release", "omni-sandbox"),
    path.join(path.dirname(process.execPath), "omni-sandbox"),
    path.join(
      path.dirname(process.argv[1] ?? process.execPath),
      "sandbox",
      `${process.platform}-${process.arch}`,
      "omni-sandbox",
    ),
  ].filter((value): value is string => Boolean(value));
}

async function verifySandboxBinary(candidate: string, signal?: AbortSignal): Promise<void> {
  let result;
  try {
    result = await runHostProcess({
      command: candidate,
      args: ["--version"],
      cwd: path.dirname(candidate),
      signal,
      maxOutputBytes: MAX_VERSION_OUTPUT_BYTES,
    });
  } catch (error) {
    if (isAbortError(error, signal)) throw error;
    throw new SandboxProcessError(
      "sandbox_launch_failed",
      "The Omni sandbox binary could not complete its version handshake.",
    );
  }
  const match = /^omni-sandbox protocol=(\d+) version=\S+\s*$/.exec(result.stdout);
  if (
    result.exitCode !== 0 ||
    result.signal ||
    result.stdoutTruncated ||
    result.stderrTruncated ||
    !match
  ) {
    throw new SandboxProcessError(
      "sandbox_launch_failed",
      "The Omni sandbox binary could not complete its version handshake.",
    );
  }
  if (match[1] !== SANDBOX_PROTOCOL_VERSION) {
    throw new SandboxProcessError(
      "sandbox_protocol_mismatch",
      "The Omni sandbox binary uses an incompatible protocol version.",
    );
  }
}
