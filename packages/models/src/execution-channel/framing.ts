import { Socket } from "node:net";

// A transport frame bound, not a generation/token budget. Streams remain incremental.
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/** One reader per connection; socket backpressure bounds unread event data. */
export class ModelChannelFrames {
  private readonly chunks: AsyncIterator<Buffer>;
  private buffered: Buffer = Buffer.alloc(0);
  constructor(readonly socket: Socket) {
    this.chunks = socket[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
    // Errors also reject the iterator/writes; never leave an unhandled socket error.
    socket.on("error", () => {});
  }
  private async readBytes(size: number): Promise<Buffer> {
    const parts: Buffer[] = [];
    let remaining = size;
    while (remaining > 0) {
      if (this.buffered.length === 0) {
        const next = await this.chunks.next();
        if (next.done) throw new Error("Model channel disconnected before completion");
        this.buffered = next.value;
      }
      const count = Math.min(remaining, this.buffered.length);
      parts.push(this.buffered.subarray(0, count));
      this.buffered = this.buffered.subarray(count);
      remaining -= count;
    }
    return Buffer.concat(parts, size);
  }
  async read(): Promise<unknown> {
    const size = (await this.readBytes(4)).readUInt32BE(0);
    if (size === 0 || size > MAX_FRAME_BYTES) throw new Error("Invalid model channel frame size");
    return JSON.parse((await this.readBytes(size)).toString("utf8"));
  }
  async write(value: unknown): Promise<void> {
    const body = Buffer.from(JSON.stringify(value));
    if (body.length > MAX_FRAME_BYTES)
      throw new Error("Model channel frame exceeds transport limit");
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length);
    await new Promise<void>((resolve, reject) => {
      this.socket.write(Buffer.concat([header, body]), (error) =>
        error ? reject(error) : resolve(),
      );
    });
  }
}
