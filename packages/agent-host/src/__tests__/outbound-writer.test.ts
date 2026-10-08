import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { AGENT_HOST_MAX_BUFFERED_BYTES } from "../contracts";
import { OutboundWriter } from "../outbound-writer";

describe("OutboundWriter", () => {
  it("drains writes accepted before close and rejects later writes", async () => {
    const callbacks: ((error?: Error) => void)[] = [];
    const payloads: string[] = [];
    const socket = {
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
      send(payload: string, callback: (error?: Error) => void) {
        payloads.push(payload);
        callbacks.push(callback);
      },
    } as unknown as WebSocket;
    const writer = new OutboundWriter(socket);

    const first = writer.send({ v: 2, type: "result", id: "1", result: { kind: "closed" } });
    const second = writer.send({ v: 2, type: "result", id: "2", result: { kind: "closed" } });
    const closing = writer.close();
    await Promise.resolve();

    expect(payloads).toHaveLength(1);
    callbacks.shift()?.();
    await first;
    await Promise.resolve();
    expect(payloads).toHaveLength(2);
    callbacks.shift()?.();

    await expect(Promise.all([second, closing])).resolves.toBeDefined();
    await expect(
      writer.send({ v: 2, type: "result", id: "3", result: { kind: "closed" } }),
    ).rejects.toMatchObject({ code: "host_closed" });
  });

  it("counts the pending payload itself against the outbound buffer limit", async () => {
    const socket = {
      readyState: WebSocket.OPEN,
      bufferedAmount: AGENT_HOST_MAX_BUFFERED_BYTES,
      send() {
        throw new Error("send should not be called");
      },
    } as unknown as WebSocket;
    const writer = new OutboundWriter(socket);

    await expect(
      writer.send({ v: 2, type: "result", id: "1", result: { kind: "closed" } }),
    ).rejects.toMatchObject({ code: "host_busy" });
  });
});
