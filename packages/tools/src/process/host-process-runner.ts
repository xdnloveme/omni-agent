import { spawn } from "node:child_process";
import {
  createAbortError,
  throwIfAborted,
  type ProcessInvocation,
  type ProcessResult,
} from "@omni-agent/core";
import { decodeUtf8Prefix } from "../text/utf8";

const TERMINATION_GRACE_MS = 500;

export interface HostProcessRequest extends ProcessInvocation {
  signal?: AbortSignal;
}

export function runHostProcess(request: HostProcessRequest): Promise<ProcessResult> {
  throwIfAborted(request.signal);
  return new Promise((resolve, reject) => {
    const detached = process.platform !== "win32";
    const child = spawn(request.command, [...request.args], {
      cwd: request.cwd,
      env: request.env,
      detached,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const budget = new OutputBudget(request.maxOutputBytes);
    const stdout = new BoundedOutput(budget);
    const stderr = new BoundedOutput(budget);
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      request.signal?.removeEventListener("abort", onAbort);
      if (killTimer) clearTimeout(killTimer);
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const kill = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        if (detached) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // The process may have exited between the close check and kill.
      }
    };
    const onAbort = () => {
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), TERMINATION_GRACE_MS);
      killTimer.unref?.();
    };

    request.signal?.addEventListener("abort", onAbort, { once: true });
    if (request.signal?.aborted) onAbort();
    child.stdout.on("data", (chunk: Buffer) => stdout.append(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.append(chunk));
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (exitCode, signal) =>
      finish(() => {
        if (request.signal?.aborted) {
          reject(createAbortError(request.signal));
          return;
        }
        resolve({
          stdout: stdout.text(),
          stderr: stderr.text(),
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
          exitCode,
          signal,
        });
      }),
    );
  });
}

class BoundedOutput {
  private readonly chunks: Buffer[] = [];
  truncated = false;

  constructor(private readonly budget: OutputBudget) {}

  append(chunk: Buffer): void {
    const accepted = this.budget.claim(chunk.length);
    if (accepted > 0) this.chunks.push(chunk.subarray(0, accepted));
    if (accepted < chunk.length) this.truncated = true;
  }

  text(): string {
    const bytes = Buffer.concat(this.chunks);
    if (!this.truncated) return bytes.toString("utf8");
    return decodeUtf8Prefix(bytes);
  }
}

class OutputBudget {
  private used = 0;

  constructor(private readonly maximum: number) {}

  claim(requested: number): number {
    const accepted = Math.min(requested, Math.max(0, this.maximum - this.used));
    this.used += accepted;
    return accepted;
  }
}
