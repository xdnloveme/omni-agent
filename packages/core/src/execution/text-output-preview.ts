import { StringDecoder } from "node:string_decoder";

const OMITTED = "\n... (output truncated) ...\n";

/** Bounded byte capture shared by streaming processes and in-memory tool output. */
export class TextOutputPreview {
  private head = Buffer.alloc(0);
  private tail = Buffer.alloc(0);
  private observed = 0;

  constructor(private readonly maximum: number) {
    if (!Number.isSafeInteger(maximum) || maximum < 0)
      throw new Error("Invalid preview byte budget");
  }

  get bytes(): number {
    return this.observed;
  }

  append(chunk: Buffer): void {
    this.observed += chunk.length;
    const available = Math.max(0, this.maximum - this.head.length);
    if (available) this.head = Buffer.concat([this.head, chunk.subarray(0, available)]);
    this.tail =
      chunk.length >= this.maximum
        ? Buffer.from(chunk.subarray(chunk.length - this.maximum))
        : Buffer.concat([this.tail, chunk]).subarray(-this.maximum);
  }

  text(maximum = this.maximum): string {
    const budget = Math.max(0, Math.min(maximum, this.maximum));
    if (this.observed <= budget) return this.head.toString("utf8");
    const marker = Buffer.from(OMITTED);
    if (budget < marker.length) return prefix(this.head, budget);
    const body = budget - marker.length;
    const headBytes = Math.ceil(body / 2);
    const tailBytes = Math.floor(body / 2);
    let start = this.tail.length - tailBytes;
    while (start < this.tail.length && (this.tail[start]! & 0xc0) === 0x80) start++;
    return prefix(this.head, headBytes) + OMITTED + this.tail.subarray(start).toString("utf8");
  }
}

function prefix(bytes: Buffer, maximum: number): string {
  return new StringDecoder("utf8").write(bytes.subarray(0, maximum));
}
