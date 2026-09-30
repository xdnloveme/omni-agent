import { StringDecoder } from "node:string_decoder";
import { ExactSensitiveTextStreamSanitizer, type OutputCallContext } from "@omni-agent/core";
import { spawn } from "node:child_process";
import {
  createAbortError,
  throwIfAborted,
  type ProcessInvocation,
  type ProcessResult,
  redactExactSensitiveText,
  TextOutputPreview,
} from "@omni-agent/core";
import { decodeUtf8Prefix } from "../text/utf8";

const TERMINATION_GRACE_MS = 500;

export interface HostProcessRequest extends ProcessInvocation {
  signal?: AbortSignal;
  output?: OutputCallContext;
}

export async function runHostProcess(request: HostProcessRequest): Promise<ProcessResult> {
  throwIfAborted(request.signal);
  if (request.output) {
    try {
      request.output.writer ??= await request.output.session.create(
        request.output.toolCallId,
        request.signal,
      );
    } catch {
      request.output.failed = true;
    }
  }
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
    const stdout = request.outputPreview
      ? new TextOutputPreview(request.maxOutputBytes)
      : new BoundedOutput(budget);
    const stderr = request.outputPreview
      ? new TextOutputPreview(request.maxOutputBytes)
      : new BoundedOutput(budget);
    const capturedParts: Partial<Record<"stdout" | "stderr", string>> = {};
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
    // Pause each pipe while its bounded chunk is persisted; never accumulate an unbounded queue.
    const stdoutDone = capture(child.stdout, stdout, "stdout", request, capturedParts);
    const stderrDone = capture(child.stderr, stderr, "stderr", request, capturedParts);
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (exitCode, signal) => {
      void Promise.all([stdoutDone(), stderrDone()]).then(
        () =>
          finish(() => {
            if (request.signal?.aborted) {
              reject(createAbortError(request.signal));
              return;
            }
            // Reserve a share for each stream, borrowing unused capacity only after capture.
            const half = Math.floor(request.maxOutputBytes / 2);
            const stdoutLimit =
              stdout instanceof TextOutputPreview && stderr instanceof TextOutputPreview
                ? request.maxOutputBytes - Math.min(half, stderr.bytes)
                : undefined;
            const stderrLimit =
              stdout instanceof TextOutputPreview && stderr instanceof TextOutputPreview
                ? request.maxOutputBytes - Math.min(request.maxOutputBytes - half, stdout.bytes)
                : undefined;
            resolve({
              ...(request.output?.writer && Object.keys(capturedParts).length
                ? {
                    outputSource: {
                      outputId: request.output.writer.id,
                      streams: capturedParts,
                    },
                  }
                : {}),
              stdout: redactExactSensitiveText(stdout.text(stdoutLimit), request.sensitiveValues),
              stderr: redactExactSensitiveText(stderr.text(stderrLimit), request.sensitiveValues),
              stdoutTruncated:
                stdout instanceof TextOutputPreview
                  ? stdout.bytes > stdoutLimit!
                  : stdout.truncated,
              stderrTruncated:
                stderr instanceof TextOutputPreview
                  ? stderr.bytes > stderrLimit!
                  : stderr.truncated,
              exitCode,
              signal,
            });
          }),
        (error: unknown) => finish(() => reject(error)),
      );
    });
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

  text(_maximum?: number): string {
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

function capture(
  stream: import("node:stream").Readable,
  preview: BoundedOutput | TextOutputPreview,
  part: "stdout" | "stderr",
  request: HostProcessRequest,
  capturedParts: Partial<Record<"stdout" | "stderr", string>>,
): () => Promise<void> {
  const decoder = new StringDecoder("utf8");
  // Keep the existing text preview, but never label lossy decoding as complete capture.
  const validator = new TextDecoder("utf-8", { fatal: true });
  const validate = (chunk?: Buffer) => {
    if (!request.output || request.output.unsupportedContent) return;
    try {
      if (chunk?.includes(0)) throw new Error("Non-text process output");
      validator.decode(chunk, { stream: chunk !== undefined });
    } catch {
      request.output.unsupportedContent = true;
    }
  };
  const sanitizer = new ExactSensitiveTextStreamSanitizer(
    request.output?.sensitive ?? request.sensitiveValues ?? { exactValues: [] },
  );
  let partWriter: import("@omni-agent/core").OutputPartWriterPort | undefined;
  let pending = Promise.resolve();
  const persist = async (text: string) => {
    if (!text) return;
    preview.append(Buffer.from(text));
    if (request.output?.writer && !request.output.failed) {
      try {
        partWriter ??= await request.output.writer.createPart(
          { label: part, mediaType: "text/plain" },
          request.signal,
        );
        await partWriter.append(text, request.signal);
        capturedParts[part] = partWriter.id;
      } catch {
        request.output.failed = true;
      }
    }
  };
  stream.on("data", (chunk: Buffer) => {
    stream.pause();
    validate(chunk);
    pending = pending.then(() => persist(sanitizer.push(decoder.write(chunk))));
    void pending.then(
      () => stream.resume(),
      () => stream.resume(),
    );
  });
  return async () => {
    await pending;
    validate();
    await persist(sanitizer.push(decoder.end()) + sanitizer.finish());
  };
}
