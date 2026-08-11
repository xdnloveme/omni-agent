import fs, { type FileHandle } from "node:fs/promises";
import { TextDecoder } from "node:util";
import { createAbortError, throwIfAborted } from "@omni-agent/core";
import { FileToolError } from "./file-errors";
import {
  createFileSnapshot,
  snapshotsEqual,
  snapshotVersion,
  type FileSnapshot,
} from "./file-snapshot";

const READ_CHUNK_BYTES = 64 * 1024;
export const MAX_FILE_READ_OUTPUT_BYTES = 64 * 1024;
const CONTENT_BUDGET_BYTES = 60 * 1024;
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

export interface StreamingReadRequest {
  path: string;
  offset: number;
  limit: number;
  lineByteOffset?: number;
  fileVersion?: string;
  signal?: AbortSignal;
}

export interface LinePagination {
  mode: "lines";
  offset: number;
  requestedLimit: number;
  returnedLines: number;
  hasMore: boolean;
  nextOffset?: number;
  totalLines?: number;
  fileVersion: string;
}

export interface LineChunkPagination {
  mode: "line_chunk";
  lineNumber: number;
  lineByteOffset: number;
  returnedBytes: number;
  partialLine: true;
  nextLineByteOffset: number;
  hasMore: true;
  fileVersion: string;
}

export type FilePagination = LinePagination | LineChunkPagination;

export interface StreamingReadResult {
  text: string;
  pagination: FilePagination;
}

export async function readTextPage(request: StreamingReadRequest): Promise<StreamingReadResult> {
  throwIfAborted(request.signal);
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(request.path, "r");
    const initialStats = await handle.stat({ bigint: true });
    if (!initialStats.isFile()) {
      throw new FileToolError("unsupported_file", "Target is not a regular file", false);
    }
    if (initialStats.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new FileToolError("unsupported_file", "File is too large to address safely", false);
    }
    const initialSnapshot = createFileSnapshot(initialStats);
    const version = snapshotVersion(initialSnapshot);
    if (request.fileVersion !== undefined && request.fileVersion !== version) {
      throw new FileToolError("file_changed", "File changed since the previous page", true);
    }

    const fileSize = Number(initialStats.size);
    const bomBytes = await detectBom(handle, fileSize);
    if (fileSize === bomBytes) {
      if (request.offset !== 1 || request.lineByteOffset !== undefined) {
        throw invalidOffset(0);
      }
      await verifyStableFile(handle, request.path, initialSnapshot);
      return {
        text: "(empty file)",
        pagination: {
          mode: "lines",
          offset: 1,
          requestedLimit: request.limit,
          returnedLines: 0,
          hasMore: false,
          totalLines: 0,
          fileVersion: version,
        },
      };
    }

    const lineStart = await findLineStart(
      handle,
      fileSize,
      bomBytes,
      request.offset,
      request.signal,
    );
    if (lineStart.position === undefined) throw invalidOffset(lineStart.totalLines);
    if (lineStart.position === fileSize) throw invalidOffset(request.offset - 1);

    let position = lineStart.position;
    const initialLineByteOffset = request.lineByteOffset ?? 0;
    if (initialLineByteOffset > 0) {
      await validateLineOffset(handle, position, initialLineByteOffset, fileSize, request.signal);
      position += initialLineByteOffset;
    }

    const lines: string[] = [];
    let outputBytes = 0;
    let lineNumber = request.offset;
    let currentLineOffset = initialLineByteOffset;
    let partial: LineChunkPagination | undefined;

    while (lines.length < request.limit && position < fileSize) {
      throwIfAborted(request.signal);
      const prefix = `${lineNumber}|`;
      const prefixBytes = Buffer.byteLength(prefix);
      const remaining = CONTENT_BUDGET_BYTES - outputBytes - prefixBytes;
      if (remaining <= 0) break;
      const part = await readLinePart(handle, position, fileSize, remaining, request.signal);
      if (!part.complete && part.body.length === 0 && lines.length > 0) break;
      const rendered = prefix + decodeUtf8(part.body);
      lines.push(rendered);
      outputBytes += Buffer.byteLength(rendered) + (lines.length > 1 ? 1 : 0);

      if (!part.complete) {
        partial = {
          mode: "line_chunk",
          lineNumber,
          lineByteOffset: currentLineOffset,
          returnedBytes: part.body.length,
          partialLine: true,
          nextLineByteOffset: currentLineOffset + part.body.length,
          hasMore: true,
          fileVersion: version,
        };
        break;
      }

      position = part.nextPosition;
      lineNumber += 1;
      currentLineOffset = 0;
    }

    await verifyStableFile(handle, request.path, initialSnapshot);
    if (partial) {
      const footer = `[Line ${partial.lineNumber} continues. Continue with:\noffset=${partial.lineNumber}, line_byte_offset=${partial.nextLineByteOffset}, file_version="${version}"]`;
      return finalize(`${lines.join("\n")}\n[Partial line]\n${footer}`, partial);
    }

    const hasMore = position < fileSize;
    const pagination: LinePagination = {
      mode: "lines",
      offset: request.offset,
      requestedLimit: request.limit,
      returnedLines: lines.length,
      hasMore,
      ...(hasMore ? { nextOffset: lineNumber } : { totalLines: lineNumber - 1 }),
      fileVersion: version,
    };
    const footer = hasMore
      ? `[More content available. Continue with:\noffset=${lineNumber}, limit=${request.limit}, file_version="${version}"]`
      : undefined;
    return finalize([lines.join("\n"), footer].filter(Boolean).join("\n"), pagination);
  } catch (error) {
    if (error instanceof FileToolError) throw error;
    if (request.signal?.aborted) throw createAbortError(request.signal);
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new FileToolError("read_failed", "File not found", true);
    }
    throw new FileToolError("read_failed", "Failed to read file", true);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function finalize(text: string, pagination: FilePagination): StreamingReadResult {
  if (Buffer.byteLength(text) > MAX_FILE_READ_OUTPUT_BYTES) {
    throw new FileToolError("read_failed", "Formatted file page exceeded output budget", true);
  }
  return { text, pagination };
}

async function detectBom(handle: FileHandle, fileSize: number): Promise<number> {
  if (fileSize < UTF8_BOM.length) return 0;
  const buffer = Buffer.alloc(UTF8_BOM.length);
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
  return bytesRead === UTF8_BOM.length && buffer.equals(UTF8_BOM) ? UTF8_BOM.length : 0;
}

async function findLineStart(
  handle: FileHandle,
  fileSize: number,
  initialPosition: number,
  targetLine: number,
  signal?: AbortSignal,
): Promise<{ position?: number; totalLines: number }> {
  if (targetLine === 1) return { position: initialPosition, totalLines: 1 };
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let position = initialPosition;
  let currentLine = 1;
  let lastByte: number | undefined;
  while (position < fileSize) {
    throwIfAborted(signal);
    const buffer = Buffer.alloc(Math.min(READ_CHUNK_BYTES, fileSize - position));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    const chunk = buffer.subarray(0, bytesRead);
    let targetIndex: number | undefined;
    for (let index = 0; index < chunk.length; index += 1) {
      if (chunk[index] !== 0x0a) continue;
      currentLine += 1;
      if (currentLine === targetLine) {
        targetIndex = index;
        break;
      }
    }
    const scanned = targetIndex === undefined ? chunk : chunk.subarray(0, targetIndex + 1);
    validateScannedChunk(decoder, scanned);
    if (targetIndex !== undefined) {
      flushDecoder(decoder);
      return { position: position + targetIndex + 1, totalLines: currentLine };
    }
    lastByte = chunk.at(-1);
    position += bytesRead;
  }
  flushDecoder(decoder);
  const totalLines =
    fileSize === initialPosition ? 0 : lastByte === 0x0a ? currentLine - 1 : currentLine;
  return { totalLines };
}

async function validateLineOffset(
  handle: FileHandle,
  lineStart: number,
  byteOffset: number,
  fileSize: number,
  signal?: AbortSignal,
): Promise<void> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let consumed = 0;
  while (consumed < byteOffset) {
    throwIfAborted(signal);
    const length = Math.min(
      READ_CHUNK_BYTES,
      byteOffset - consumed,
      fileSize - lineStart - consumed,
    );
    if (length <= 0) throw invalidLineOffset();
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, lineStart + consumed);
    if (bytesRead === 0) throw invalidLineOffset();
    const chunk = buffer.subarray(0, bytesRead);
    if (chunk.includes(0x0a)) throw invalidLineOffset();
    validateScannedChunk(decoder, chunk);
    consumed += bytesRead;
  }
  flushDecoder(decoder);
  const terminator = Buffer.alloc(Math.min(2, fileSize - lineStart - byteOffset));
  const { bytesRead } = await handle.read(terminator, 0, terminator.length, lineStart + byteOffset);
  if (
    bytesRead === 0 ||
    terminator[0] === 0x0a ||
    (bytesRead > 1 && terminator[0] === 0x0d && terminator[1] === 0x0a)
  ) {
    throw invalidLineOffset();
  }
}

async function readLinePart(
  handle: FileHandle,
  position: number,
  fileSize: number,
  maximumBodyBytes: number,
  signal?: AbortSignal,
): Promise<{ body: Buffer; complete: boolean; nextPosition: number }> {
  const chunks: Buffer[] = [];
  let collected = 0;
  let cursor = position;
  const readLimit = maximumBodyBytes + 4;
  while (cursor < fileSize && collected < readLimit) {
    throwIfAborted(signal);
    const length = Math.min(READ_CHUNK_BYTES, fileSize - cursor, readLimit - collected);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, cursor);
    if (bytesRead === 0) break;
    const chunk = buffer.subarray(0, bytesRead);
    const newline = chunk.indexOf(0x0a);
    if (newline >= 0) {
      chunks.push(chunk.subarray(0, newline));
      let body = Buffer.concat(chunks);
      if (body.at(-1) === 0x0d) body = body.subarray(0, body.length - 1);
      if (body.length <= maximumBodyBytes) {
        validateTextBytes(body);
        return { body, complete: true, nextPosition: cursor + newline + 1 };
      }
      break;
    }
    chunks.push(chunk);
    collected += bytesRead;
    cursor += bytesRead;
  }
  const collectedBody = Buffer.concat(chunks);
  if (cursor >= fileSize && collectedBody.length <= maximumBodyBytes) {
    validateTextBytes(collectedBody);
    return { body: collectedBody, complete: true, nextPosition: fileSize };
  }
  const body = safeUtf8Prefix(collectedBody, maximumBodyBytes);
  return { body, complete: false, nextPosition: position + body.length };
}

async function verifyStableFile(
  handle: FileHandle,
  path: string,
  expected: FileSnapshot,
): Promise<void> {
  try {
    const handleSnapshot = createFileSnapshot(await handle.stat({ bigint: true }));
    const pathSnapshot = createFileSnapshot(await fs.stat(path, { bigint: true }));
    if (!snapshotsEqual(expected, handleSnapshot) || !snapshotsEqual(expected, pathSnapshot)) {
      throw new FileToolError("file_changed", "File changed while it was being read", true);
    }
  } catch (error) {
    if (error instanceof FileToolError) throw error;
    throw new FileToolError("file_changed", "File changed while it was being read", true);
  }
}

function validateScannedChunk(decoder: TextDecoder, chunk: Buffer): void {
  if (chunk.includes(0)) throw unsupportedText();
  try {
    decoder.decode(chunk, { stream: true });
  } catch {
    throw unsupportedText();
  }
}

function flushDecoder(decoder: TextDecoder): void {
  try {
    decoder.decode();
  } catch {
    throw unsupportedText();
  }
}

function validateTextBytes(bytes: Buffer): void {
  if (bytes.includes(0)) throw unsupportedText();
  decodeUtf8(bytes);
}

function decodeUtf8(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw unsupportedText();
  }
}

function safeUtf8Prefix(bytes: Buffer, maximumBytes: number): Buffer {
  const end = Math.min(bytes.length, maximumBytes);
  for (let candidate = end; candidate >= Math.max(0, end - 3); candidate -= 1) {
    const prefix = bytes.subarray(0, candidate);
    try {
      validateTextBytes(prefix);
      return prefix;
    } catch (error) {
      if (!(error instanceof FileToolError)) throw error;
    }
  }
  throw unsupportedText();
}

function unsupportedText(): FileToolError {
  return new FileToolError("unsupported_file", "File is not valid UTF-8 text", false);
}

function invalidOffset(totalLines: number): FileToolError {
  return new FileToolError(
    "invalid_pagination",
    `Requested offset is beyond the end of the file (${totalLines} lines)`,
    false,
  );
}

function invalidLineOffset(): FileToolError {
  return new FileToolError(
    "invalid_pagination",
    "line_byte_offset is outside the line or not on a UTF-8 boundary",
    false,
  );
}
