import { TextDecoder } from "node:util";

export interface TruncatedUtf8Text {
  text: string;
  truncated: boolean;
}

export function truncateUtf8Text(value: string, maximumBytes: number): TruncatedUtf8Text {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maximumBytes) return { text: value, truncated: false };
  return { text: decodeUtf8Prefix(bytes, maximumBytes), truncated: true };
}

export function decodeUtf8Prefix(bytes: Uint8Array, maximumBytes = bytes.byteLength): string {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = Math.min(buffer.length, Math.max(0, maximumBytes));
  for (let removed = 0; removed <= Math.min(3, end); removed += 1) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, end - removed));
    } catch {
      // A byte boundary can split the final UTF-8 code point.
    }
  }
  return buffer.subarray(0, end).toString("utf8");
}
