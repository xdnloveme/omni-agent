import { describe, expect, it } from "vitest";
import { runHostProcess } from "../process/host-process-runner";

describe("HostProcessRunner", () => {
  it("shares one byte budget across stdout and stderr", async () => {
    const result = await runHostProcess({
      command: process.execPath,
      args: ["-e", "process.stdout.write('a'.repeat(64)); process.stderr.write('b'.repeat(64))"],
      cwd: process.cwd(),
      maxOutputBytes: 32,
    });

    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(
      32,
    );
    expect(result.stdoutTruncated || result.stderrTruncated).toBe(true);
  });

  it("truncates output at a complete UTF-8 boundary", async () => {
    const result = await runHostProcess({
      command: process.execPath,
      args: ["-e", "process.stdout.write('界界')"],
      cwd: process.cwd(),
      maxOutputBytes: 4,
    });

    expect(result.stdout).toBe("界");
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(4);
    expect(result.stdoutTruncated).toBe(true);
  });

  it("propagates cancellation after terminating the process", async () => {
    const controller = new AbortController();
    const pending = runHostProcess({
      command: process.execPath,
      args: ["-e", "setInterval(() => undefined, 1000)"],
      cwd: process.cwd(),
      signal: controller.signal,
      maxOutputBytes: 1024,
    });
    setTimeout(() => controller.abort(), 20);

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("reports an external signal termination", async () => {
    const result = await runHostProcess({
      command: process.execPath,
      args: ["-e", "process.kill(process.pid, 'SIGTERM')"],
      cwd: process.cwd(),
      maxOutputBytes: 1024,
    });

    expect(result).toMatchObject({ exitCode: null, signal: "SIGTERM" });
  });
});
