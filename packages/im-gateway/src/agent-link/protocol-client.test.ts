import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { AgentHostProtocolClient } from "./protocol-client";

const servers: WebSocketServer[] = [];
const clients: AgentHostProtocolClient[] = [];

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          for (const socket of server.clients) socket.terminate();
          server.close(() => resolve());
        }),
    ),
  );
});

describe("AgentHostProtocolClient", () => {
  it("does not submit a Run cancelled during authentication", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const received: string[] = [];
    let releaseReady!: () => void;
    const hello = new Promise<void>((resolve) => {
      server.on("connection", (socket) =>
        socket.on("message", (data) => {
          const message = JSON.parse(data.toString());
          received.push(message.type);
          if (message.type === "hello") {
            releaseReady = () =>
              socket.send(JSON.stringify({ v: 2, type: "ready", connectionId: "delayed" }));
            resolve();
          } else if (message.type === "list_agents") {
            socket.send(
              JSON.stringify({
                v: 2,
                type: "result",
                id: message.id,
                result: { kind: "agents", agents: [] },
              }),
            );
          }
        }),
      );
    });
    const client = new AgentHostProtocolClient(
      `ws://127.0.0.1:${address.port}`,
      randomBytes(32).toString("base64url"),
    );
    clients.push(client);
    const controller = new AbortController();
    const iterator = client
      .stream(
        {
          v: 2,
          id: "cancel-before-ready",
          type: "run",
          agentId: "coding",
          sessionId: "s1",
          text: "work",
        },
        controller.signal,
      )
      [Symbol.asyncIterator]();
    const first = iterator.next();
    const rejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
    await hello;
    controller.abort();
    const barrier = client.request({ v: 2, id: "barrier", type: "list_agents" });
    releaseReady();
    await rejected;
    await barrier;
    expect(received).toEqual(["hello", "list_agents"]);
  });

  it("does not submit a Run cancelled before its queued send executes", async () => {
    const { client } = await connect();
    const controller = new AbortController();
    const iterator = client
      .stream(
        {
          v: 2,
          id: "queued-cancel",
          type: "run",
          agentId: "coding",
          sessionId: "s1",
          text: "work",
        },
        controller.signal,
      )
      [Symbol.asyncIterator]();
    const first = iterator.next();
    // Allow start() to queue its write, but cancel before the write queue runs.
    await Promise.resolve();
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
  });

  it("correlates cancellation and accepts one terminal Run event", async () => {
    const { client, messages } = await connect();
    const controller = new AbortController();
    const stream = client.stream(
      {
        v: 2,
        id: "run-1",
        type: "run",
        agentId: "coding",
        sessionId: "session-1",
        text: "work",
      },
      controller.signal,
    );
    const iterator = stream[Symbol.asyncIterator]();
    const started = iterator.next();
    const run = await nextMessage(messages);
    expect(run).toMatchObject({ type: "run", id: "run-1" });
    run.socket.send(
      JSON.stringify({
        v: 2,
        type: "event",
        requestId: "run-1",
        event: { type: "started", requestId: "run-1", sessionId: "session-1" },
      }),
    );
    await expect(started).resolves.toMatchObject({
      value: { type: "started", requestId: "run-1" },
    });

    controller.abort();
    const cancel = await nextMessage(messages);
    expect(cancel).toMatchObject({ type: "cancel", requestId: "run-1" });
    cancel.socket.send(
      JSON.stringify({
        v: 2,
        type: "result",
        id: cancel.id,
        result: { kind: "cancel_requested", requestId: "run-1" },
      }),
    );
    cancel.socket.send(
      JSON.stringify({
        v: 2,
        type: "event",
        requestId: "run-1",
        event: { type: "cancelled" },
      }),
    );

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: "cancelled" },
    });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("projects an authenticated disconnect as an unknown Run terminal", async () => {
    const { client, messages } = await connect();
    const stream = client.stream({
      v: 2,
      id: "run-2",
      type: "run",
      agentId: "coding",
      sessionId: "session-1",
      text: "work",
    });
    const iterator = stream[Symbol.asyncIterator]();
    const terminal = iterator.next();
    const run = await nextMessage(messages);
    run.socket.close();

    await expect(terminal).resolves.toMatchObject({
      done: false,
      value: { type: "unknown" },
    });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("accepts a valid server event larger than the request limit", async () => {
    const { client, messages } = await connect();
    const stream = client.stream({
      v: 2,
      id: "run-large",
      type: "run",
      agentId: "coding",
      sessionId: "session-1",
      text: "work",
    });
    const iterator = stream[Symbol.asyncIterator]();
    const first = iterator.next();
    const run = await nextMessage(messages);
    const text = "x".repeat(70_000);
    run.socket.send(
      JSON.stringify({
        v: 2,
        type: "event",
        requestId: "run-large",
        event: { type: "text_delta", text },
      }),
    );
    run.socket.send(
      JSON.stringify({
        v: 2,
        type: "event",
        requestId: "run-large",
        event: { type: "completed" },
      }),
    );

    await expect(first).resolves.toEqual({
      done: false,
      value: { type: "text_delta", text },
    });
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: "completed" },
    });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("denies Protocol v2 permission requests without leaving the run blocked", async () => {
    const { client, messages } = await connect();
    const agents = client.request({ v: 2, id: "list", type: "list_agents" });
    const list = await nextMessage(messages);
    list.socket.send(
      JSON.stringify({
        v: 2,
        type: "permission.requested",
        requestId: "run-1",
        permissionId: "permission-1",
        expiresAt: Date.now() + 1_000,
        presentation: { title: "Network access", resources: ["https://example.com"] },
      }),
    );

    const denial = await nextMessage(messages);
    expect(denial).toMatchObject({
      type: "resolve_permission",
      permissionId: "permission-1",
      decision: "deny",
    });
    denial.socket.send(
      JSON.stringify({
        v: 2,
        type: "result",
        id: denial.id,
        result: { kind: "permission_resolved", permissionId: "permission-1" },
      }),
    );
    denial.socket.send(
      JSON.stringify({
        v: 2,
        type: "permission.resolved",
        requestId: "run-1",
        permissionId: "permission-1",
        decision: "deny",
        reason: "user",
      }),
    );
    list.socket.send(
      JSON.stringify({
        v: 2,
        type: "result",
        id: "list",
        result: { kind: "agents", agents: [] },
      }),
    );

    await expect(agents).resolves.toEqual({ kind: "agents", agents: [] });
  });
});

async function connect(): Promise<{
  client: AgentHostProtocolClient;
  messages: AsyncIterableIterator<Record<string, unknown> & { socket: WebSocket }>;
}> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP WebSocket address");
  const queue = eventQueue<Record<string, unknown> & { socket: WebSocket }>();
  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      if (message.type === "hello") {
        socket.send(
          JSON.stringify({
            v: 2,
            type: "ready",
            connectionId: "connection-1",
          }),
        );
        return;
      }
      queue.push({ ...message, socket });
    });
  });
  const client = new AgentHostProtocolClient(
    `ws://127.0.0.1:${address.port}`,
    randomBytes(32).toString("base64url"),
  );
  clients.push(client);
  await client.connect();
  return { client, messages: queue.iterator };
}

async function nextMessage<T>(messages: AsyncIterableIterator<T>): Promise<T> {
  const result = await messages.next();
  if (result.done) throw new Error("Message stream ended unexpectedly");
  return result.value;
}

function eventQueue<T>(): { readonly iterator: AsyncIterableIterator<T>; push(value: T): void } {
  const values: T[] = [];
  const readers: Array<(result: IteratorResult<T>) => void> = [];
  return {
    iterator: {
      next: () => {
        const value = values.shift();
        if (value) return Promise.resolve({ done: false, value });
        return new Promise((resolve) => readers.push(resolve));
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    },
    push(value) {
      const reader = readers.shift();
      if (reader) reader({ done: false, value });
      else values.push(value);
    },
  };
}
