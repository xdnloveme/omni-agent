import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, rm, lstat } from "node:fs/promises";
import { join, dirname } from "node:path";
import {
  InterprocessFileLock,
  readTextPage,
  throwIfAborted,
  type SessionOutputPort,
  type OutputWriterPort,
  type OutputRecord,
  type OutputReference,
  type OutputPart,
  type OutputReadRequest,
  type OutputReadResult,
} from "@omni-agent/core";
import { AtomicJsonFile } from "./atomic-json-file";

export interface OutputStorageLimits {
  readonly previewBytes: number;
  readonly callBytes: number;
  readonly sessionBytes: number;
}
export const DEFAULT_OUTPUT_LIMITS: OutputStorageLimits = {
  previewBytes: 10 * 1024,
  callBytes: 16 * 1024 * 1024,
  sessionBytes: 256 * 1024 * 1024,
};
// Bound metadata separately from body bytes, including zero-output calls.
const MAX_SESSION_RECORDS = 1024;
const MAX_RECORD_PARTS = 128;
interface StoredPart extends OutputPart {
  readonly lines: number;
  readonly endsWithNewline: boolean;
}
interface StoredRecord {
  version: 1;
  id: string;
  toolCallId: string;
  state: OutputRecord["state"] | "writing";
  reason?: OutputRecord["reason"];
  parts: StoredPart[];
}

/** One Session lifetime lease protects readers/writers from clear; metadata locks remain short. */
export class SessionArtifactStore {
  constructor(
    readonly root: string,
    readonly limits = DEFAULT_OUTPUT_LIMITS,
  ) {
    for (const value of Object.values(limits))
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new Error("Invalid output resource limit");
    if (limits.callBytes > limits.sessionBytes)
      throw new Error("Output call limit exceeds Session limit");
  }

  async withSession<T>(
    sessionId: string,
    run: (port: SessionOutputPort) => Promise<T>,
  ): Promise<T> {
    segment(sessionId);
    return this.lease(sessionId).runExclusive(async () => {
      const directory = join(this.root, sessionId);
      await privateDirectory(directory);
      await this.recover(directory);
      let active = true;
      const assertActive = () => {
        if (!active) throw new Error("Output Session lease has ended");
      };
      const port: SessionOutputPort = {
        previewBytes: this.limits.previewBytes,
        create: async (toolCallId, signal) => {
          assertActive();
          return this.create(directory, toolCallId, assertActive, signal);
        },
        read: async (request, signal) => {
          assertActive();
          return this.read(directory, request, signal, assertActive);
        },
        resolve: async (reference, signal) =>
          this.metadataLock(directory).runExclusive(async () => {
            assertActive();
            return publicRecord(await this.resolveRecord(directory, reference, signal));
          }, signal),
      };
      try {
        return await run(port);
      } finally {
        active = false;
        // Take the same metadata lock to wait for already-admitted bounded writes.
        await this.metadataLock(directory).runExclusive(() => this.recover(directory));
      }
    });
  }

  async clear(sessionId: string, clearSession: () => Promise<void>): Promise<void> {
    segment(sessionId);
    await this.lease(sessionId).runExclusive(async () => {
      await clearSession();
      await rm(join(this.root, sessionId), { recursive: true, force: true });
    });
  }

  /** Existing context snapshots keep their stable paths and digest contract. */
  static async writeSnapshot(path: string, content: string): Promise<void> {
    await privateDirectory(dirname(path));
    try {
      const file = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await file.writeFile(content, "utf8");
      } finally {
        await file.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if ((await this.readSnapshot(path)) !== content)
        throw new Error("Context artifact digest collision");
    }
  }

  static async readSnapshot(path: string): Promise<string> {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      return await file.readFile("utf8");
    } finally {
      await file.close();
    }
  }

  private lease(sessionId: string) {
    return new InterprocessFileLock(join(this.root, ".leases", `${sessionId}.lock`));
  }
  private metadataLock(directory: string) {
    return new InterprocessFileLock(`${directory}.metadata.lock`);
  }
  private async recover(directory: string): Promise<void> {
    // The Session lease excludes live writers; only store-owned names may be reclaimed.
    const names = await readdir(directory);
    const referenced = new Set<string>();
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const stored = await this.record(directory, name.slice(0, -5));
      for (const part of stored.parts) referenced.add(`${stored.id}.${part.id}.data`);
      if (stored.state !== "writing") continue;
      let missing = false;
      for (let index = 0; index < stored.parts.length; index++) {
        const part = stored.parts[index]!;
        try {
          const inspected = await inspectPart(join(directory, `${stored.id}.${part.id}.data`));
          stored.parts[index] = {
            ...part,
            ...inspected,
            observedBytes: Math.max(part.observedBytes, inspected.bytes),
            complete: false,
          };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          // Preserve a missing-body diagnostic; never fabricate an empty successful capture.
          missing = true;
          stored.parts[index] = { ...part, complete: false };
        }
      }
      stored.state = missing ? "incomplete" : "interrupted";
      stored.reason = missing ? "persistence_error" : "abandoned";
      await new AtomicJsonFile<StoredRecord>(join(directory, name)).write(stored);
    }
    for (const name of names) {
      const orphan =
        /^[a-f0-9-]{36}\.[a-zA-Z0-9_-]{1,128}\.data$/.test(name) && !referenced.has(name);
      const temporary = /^[a-f0-9-]{36}\.json\.\d+\.[a-f0-9-]{36}\.tmp$/.test(name);
      if ((orphan || temporary) && (await lstat(join(directory, name))).isFile())
        await rm(join(directory, name));
    }
  }
  private async record(directory: string, id: string): Promise<StoredRecord> {
    segment(id);
    const path = join(directory, `${id}.json`);
    const data: unknown = JSON.parse(await SessionArtifactStore.readSnapshot(path));
    if (
      !data ||
      typeof data !== "object" ||
      !("version" in data) ||
      data.version !== 1 ||
      !("id" in data) ||
      data.id !== id ||
      !("parts" in data) ||
      !Array.isArray(data.parts)
    )
      throw new Error("Invalid output record");
    const record = data as StoredRecord;
    if (
      !["writing", "complete", "interrupted", "incomplete"].includes(record.state) ||
      typeof record.toolCallId !== "string" ||
      record.parts.length > MAX_RECORD_PARTS
    )
      throw new Error("Invalid output record state");
    for (const part of record.parts) {
      segment(part.id);
      if (
        ![part.bytes, part.observedBytes, part.lines].every(
          (v) => Number.isSafeInteger(v) && v >= 0,
        ) ||
        typeof part.endsWithNewline !== "boolean" ||
        typeof part.mediaType !== "string" ||
        (part.label !== undefined && (typeof part.label !== "string" || part.label.length > 128)) ||
        typeof part.complete !== "boolean" ||
        !/^[a-f0-9]{64}$/.test(part.sha256)
      )
        throw new Error("Invalid output part");
    }
    return record;
  }
  private async create(
    directory: string,
    toolCallId: string,
    assertActive: () => void,
    signal?: AbortSignal,
  ): Promise<OutputWriterPort> {
    if (toolCallId.length > 256) throw new Error("Output tool call identifier is too long");
    const id = randomUUID();
    const record: StoredRecord = { version: 1, id, toolCallId, state: "writing", parts: [] };
    const file = new AtomicJsonFile<StoredRecord>(join(directory, `${id}.json`));
    await this.metadataLock(directory).runExclusive(async () => {
      assertActive();
      if (
        (await readdir(directory)).filter((name) => name.endsWith(".json")).length >=
        MAX_SESSION_RECORDS
      )
        throw new Error("Output Session record limit reached");
      await file.write(record);
    }, signal);
    let finished = false;
    return {
      id,
      createPart: async ({ label, mediaType }, signal) => {
        if (label.length > 128 || mediaType.length > 128)
          throw new Error("Output part description is too long");
        const partId = randomUUID();
        await this.metadataLock(directory).runExclusive(async () => {
          assertActive();
          if (finished) throw new Error("Output record is finalized");
          if (record.parts.length >= MAX_RECORD_PARTS) {
            record.reason = "limit";
            await file.write(record);
            throw new Error("Output part limit reached");
          }
          record.parts.push({
            id: partId,
            label,
            mediaType,
            bytes: 0,
            observedBytes: 0,
            complete: true,
            sha256: createHash("sha256").digest("hex"),
            lines: 0,
            endsWithNewline: false,
          });
          // Persist intent before creating the body so interrupted creation remains recoverable.
          await file.write(record);
          const handle = await open(
            join(directory, `${id}.${partId}.data`),
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o600,
          );
          await handle.close();
        }, signal);
        return {
          id: partId,
          append: async (text, signal) => {
            await this.metadataLock(directory).runExclusive(async () => {
              assertActive();
              if (finished) throw new Error("Output record is finalized");
              const part = record.parts.find((item) => item.id === partId)!;
              const ownBytes = record.parts.reduce((sum, item) => sum + item.bytes, 0);
              let sessionBytes = 0;
              for (const name of await readdir(directory)) {
                if (name.endsWith(".data"))
                  sessionBytes += Number((await lstat(join(directory, name))).size);
              }
              const available = Math.max(
                0,
                Math.min(this.limits.callBytes - ownBytes, this.limits.sessionBytes - sessionBytes),
              );
              throwIfAborted(signal);
              const input = Buffer.from(text);
              let end = Math.min(input.length, available);
              while (end > 0 && end < input.length && (input[end]! & 0xc0) === 0x80) end--;
              const bytes = input.subarray(0, end);
              const path = join(directory, `${id}.${partId}.data`);
              const handle = await open(
                path,
                constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW,
                0o600,
              );
              try {
                await handle.writeFile(bytes);
              } finally {
                await handle.close();
              }
              const complete = part.complete && end === input.length;
              const next = {
                ...part,
                bytes: part.bytes + bytes.length,
                observedBytes: part.observedBytes + input.length,
                lines: part.lines + (bytes.toString("utf8").match(/\n/g)?.length ?? 0),
                endsWithNewline: bytes.length
                  ? bytes[bytes.length - 1] === 10
                  : part.endsWithNewline,
                complete,
              };
              record.parts[record.parts.indexOf(part)] = next;
              if (!complete) record.reason = "limit";
              await file.write(record);
            }, signal);
          },
        };
      },
      finish: async ({ interrupted = false, failure, signal } = {}) =>
        this.metadataLock(directory).runExclusive(async () => {
          assertActive();
          if (finished) return publicRecord(record);
          for (let i = 0; i < record.parts.length; i++) {
            const part = record.parts[i]!;
            const inspected = await inspectPart(join(directory, `${id}.${part.id}.data`), signal);
            record.parts[i] = {
              ...part,
              ...inspected,
              complete: part.complete && !interrupted && !failure,
            };
          }
          if (failure) record.reason = failure;
          record.state = interrupted ? "interrupted" : record.reason ? "incomplete" : "complete";
          if (interrupted) record.reason = "interrupted";
          throwIfAborted(signal);
          await file.write(record);
          finished = true;
          return publicRecord(record);
        }, signal),
    };
  }
  /** Called under the metadata lock. Both readback and reference resolution use these checks. */
  private async resolveRecord(
    directory: string,
    reference: OutputReference,
    signal?: AbortSignal,
  ): Promise<StoredRecord> {
    throwIfAborted(signal);
    const record = await this.record(directory, reference.outputId);
    if (record.state === "writing") throw new Error("Output has not been finalized");
    if (reference.partId !== undefined) segment(reference.partId);
    const parts =
      reference.partId === undefined
        ? record.parts
        : record.parts.filter((part) => part.id === reference.partId);
    if (reference.partId !== undefined && !parts.length)
      throw new Error("Output part does not exist");
    for (const part of parts) {
      const path = join(directory, `${record.id}.${part.id}.data`);
      if (!(await lstat(path)).isFile()) throw new Error("Invalid output resource");
      const inspected = await inspectPart(path, signal);
      if (inspected.sha256 !== part.sha256 || inspected.bytes !== part.bytes)
        throw new Error("Output content integrity check failed");
    }
    return record;
  }

  private async read(
    directory: string,
    request: OutputReadRequest,
    signal: AbortSignal | undefined,
    assertActive: () => void,
  ): Promise<OutputReadResult> {
    return this.metadataLock(directory).runExclusive(async () => {
      assertActive();
      throwIfAborted(signal);
      const record = await this.resolveRecord(directory, request, signal);
      const part = record.parts.find((item) => item.id === request.partId)!;
      const path = join(directory, `${record.id}.${part.id}.data`);
      const page = await readTextPage({
        path,
        offset:
          request.tail === undefined
            ? (request.offset ?? 1)
            : Math.max(
                1,
                part.lines + (part.bytes && !part.endsWithNewline ? 1 : 0) - request.tail + 1,
              ),
        limit: request.tail ?? request.limit ?? 500,
        lineByteOffset: request.lineByteOffset,
        fileVersion: request.fileVersion,
        signal,
      });
      return { ...page, record: publicRecord(record) };
    }, signal);
  }
}

function publicRecord(record: StoredRecord): OutputRecord {
  if (record.state === "writing") throw new Error("Output is not finalized");
  return {
    version: 1,
    id: record.id,
    toolCallId: record.toolCallId,
    state: record.state,
    ...(record.reason ? { reason: record.reason } : {}),
    parts: record.parts.map(({ lines: _lines, endsWithNewline: _ends, ...part }) => part),
  };
}
function segment(value: string) {
  if (value.length > 128 || !/^[a-zA-Z0-9_-]+$/.test(value))
    throw new Error("Invalid output identifier");
}
async function privateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (!(await lstat(path)).isDirectory()) throw new Error("Output directory must not be a symlink");
}

/** Inspect bounded retained data without loading the entire record into memory. */
async function inspectPart(path: string, signal?: AbortSignal) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const hash = createHash("sha256");
  let bytes = 0;
  let lines = 0;
  let endsWithNewline = false;
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      throwIfAborted(signal);
      hash.update(chunk);
      bytes += chunk.length;
      for (const byte of chunk) if (byte === 10) lines++;
      if (chunk.length) endsWithNewline = chunk[chunk.length - 1] === 10;
    }
  } finally {
    await handle.close();
  }
  return { bytes, lines, endsWithNewline, sha256: hash.digest("hex") };
}
