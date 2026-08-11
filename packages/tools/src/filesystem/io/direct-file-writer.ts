import fs from "node:fs/promises";
import { throwIfAborted } from "@omni-agent/core";
import { FileToolError } from "./file-errors";
import { createFileSnapshot, snapshotsEqual, type FileSnapshot } from "./file-snapshot";

export interface DirectWriteRequest {
  path: string;
  content: Uint8Array;
  expected: FileSnapshot | "missing";
  signal?: AbortSignal;
}

export interface DirectWriteResult {
  bytesWritten: number;
}

export async function writeDirectFile(request: DirectWriteRequest): Promise<DirectWriteResult> {
  await verifyExpectedTarget(request.path, request.expected);
  throwIfAborted(request.signal);
  try {
    if (request.expected === "missing") {
      await fs.writeFile(request.path, request.content, { flag: "wx" });
    } else {
      await fs.writeFile(request.path, request.content);
    }
    return { bytesWritten: request.content.byteLength };
  } catch (error) {
    if (request.expected === "missing" && (error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new FileToolError("file_changed", "Target file appeared before creation", true);
    }
    throw new FileToolError("write_failed", "Failed to write file", false, {
      targetState: "unknown",
    });
  }
}

async function verifyExpectedTarget(
  path: string,
  expected: FileSnapshot | "missing",
): Promise<void> {
  try {
    const stats = await fs.stat(path, { bigint: true });
    if (expected === "missing") {
      throw new FileToolError("file_changed", "Target file appeared before creation", true);
    }
    if (!stats.isFile()) {
      throw new FileToolError("unsupported_file", "Target is not a regular file", false);
    }
    if (!snapshotsEqual(expected, createFileSnapshot(stats))) {
      throw new FileToolError("file_changed", "File changed before write", true);
    }
  } catch (error) {
    if (error instanceof FileToolError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (expected === "missing") return;
      throw new FileToolError("file_changed", "Target file was removed before write", true);
    }
    throw new FileToolError("write_failed", "Unable to verify target before write", false, {
      targetState: "unknown",
    });
  }
}
