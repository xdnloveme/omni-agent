import { FileToolError } from "./file-errors";

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

export interface DecodedTextFile {
  text: string;
  hasBom: boolean;
}

export function decodeTextFile(content: Buffer): DecodedTextFile {
  const hasBom = content.subarray(0, UTF8_BOM.length).equals(UTF8_BOM);
  const body = hasBom ? content.subarray(UTF8_BOM.length) : content;
  if (body.includes(0)) {
    throw new FileToolError("unsupported_file", "File contains NUL bytes", false);
  }
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(body), hasBom };
  } catch {
    throw new FileToolError("unsupported_file", "File is not valid UTF-8 text", false);
  }
}

export function encodeTextFile(text: string, hasBom = false): Buffer {
  assertTextValue(text);
  const body = Buffer.from(text, "utf8");
  return hasBom ? Buffer.concat([UTF8_BOM, body]) : body;
}

export function assertTextValue(text: string, maximumBytes?: number): void {
  if (text.includes("\0")) {
    throw new FileToolError("unsupported_file", "Text contains NUL bytes", false);
  }
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        throw new FileToolError("unsupported_file", "Text contains invalid Unicode", false);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new FileToolError("unsupported_file", "Text contains invalid Unicode", false);
    }
  }
  if (maximumBytes !== undefined && Buffer.byteLength(text, "utf8") > maximumBytes) {
    throw new FileToolError("file_too_large", `Text exceeds the ${maximumBytes} byte limit`, false);
  }
}

export function assertFileSize(size: bigint, maximumBytes: number): void {
  if (size > BigInt(maximumBytes)) {
    throw new FileToolError("file_too_large", `File exceeds the ${maximumBytes} byte limit`, false);
  }
}
