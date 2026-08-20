import { open } from "node:fs/promises";

const JSONL_READ_BYTES = 512 * 1024;

export interface JsonLineEntry<T> {
  readonly value: T;
  readonly cursor: number;
}

export interface JsonLinesChunk<T> {
  readonly entries: readonly JsonLineEntry<T>[];
  readonly cursor: number;
}

export async function readJsonLines<T>(path: string): Promise<T[]> {
  return readValidatedJsonLines(path, isUnknownRecord<T>);
}

export async function readValidatedJsonLines<T>(
  path: string,
  validate: (value: unknown) => value is T,
): Promise<T[]> {
  const records: T[] = [];
  let cursor = 0;
  while (true) {
    const page = await readJsonLinesChunk<T>(path, cursor, Number.POSITIVE_INFINITY, validate);
    records.push(...page.entries.map((entry) => entry.value));
    if (page.cursor === cursor) return records;
    cursor = page.cursor;
  }
}

export async function readJsonLinesChunk<T>(
  path: string,
  cursor = 0,
  limit = Number.POSITIVE_INFINITY,
  validate: (value: unknown) => value is T = isUnknownRecord<T>,
): Promise<JsonLinesChunk<T>> {
  if (!Number.isInteger(cursor) || cursor < 0) throw new Error(`Invalid JSONL cursor: ${cursor}`);
  if (!(limit > 0)) throw new Error(`Invalid JSONL limit: ${limit}`);
  let file;
  try {
    file = await open(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: [], cursor };
    throw error;
  }
  try {
    const size = (await file.stat()).size;
    if (cursor >= size) return { entries: [], cursor: Math.min(cursor, size) };
    const buffer = Buffer.allocUnsafe(Math.min(JSONL_READ_BYTES, size - cursor));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, cursor);
    const entries: JsonLineEntry<T>[] = [];
    let lineStart = 0;
    let nextCursor = cursor;
    for (let index = 0; index < bytesRead; index++) {
      if (buffer[index] !== 0x0a) continue;
      const lineEnd = index;
      nextCursor = cursor + index + 1;
      if (lineEnd > lineStart) {
        try {
          const value: unknown = JSON.parse(buffer.subarray(lineStart, lineEnd).toString("utf8"));
          if (!validate(value)) {
            lineStart = index + 1;
            continue;
          }
          entries.push({
            value,
            cursor: nextCursor,
          });
        } catch {
          // Malformed complete records are isolated; an incomplete tail has no newline.
        }
      }
      lineStart = index + 1;
      if (entries.length >= limit) break;
    }
    return { entries, cursor: nextCursor };
  } finally {
    await file.close();
  }
}

function isUnknownRecord<T>(_value: unknown): _value is T {
  return true;
}
