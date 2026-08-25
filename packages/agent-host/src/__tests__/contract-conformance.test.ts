import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentServiceEvent, AgentServicePort } from "@omni-agent/app";
import WebSocket from "ws";
import type { AgentHostServerMessage } from "../contracts";
import { startAgentHost } from "../websocket-agent-host";

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("Agent Host Contract conformance", () => {
  it("forwards Session operations without adding Host-owned business decisions", async () => {
    const service = serviceFixture();
    const { socket, messages } = await connect(service);

    socket.send(
      JSON.stringify({
        v: 1,
        id: "open",
        type: "open_session",
        agentId: "coding",
        sessionId: "existing",
      }),
    );
    socket.send(JSON.stringify({ v: 1, id: "create", type: "create_session", agentId: "coding" }));
    socket.send(
      JSON.stringify({
        v: 1,
        id: "close",
        type: "close_session",
        agentId: "coding",
        sessionId: "existing",
      }),
    );

    const responses = await Promise.all([messages.next(), messages.next(), messages.next()]);
    expect(responses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "open",
          result: expect.objectContaining({ kind: "session" }),
        }),
        expect.objectContaining({
          id: "create",
          result: expect.objectContaining({ kind: "session" }),
        }),
        expect.objectContaining({
          id: "close",
          result: expect.objectContaining({ kind: "closed" }),
        }),
      ]),
    );
    expect(service.openSession).toHaveBeenCalledExactlyOnceWith({
      agentId: "coding",
      sessionId: "existing",
    });
    expect(service.createSession).toHaveBeenCalledExactlyOnceWith({ agentId: "coding" });
    expect(service.closeSession).toHaveBeenCalledExactlyOnceWith({
      agentId: "coding",
      sessionId: "existing",
    });
  });

  it("rejects a duplicate active connection request id without duplicating the Service call", async () => {
    const pending = deferred<readonly []>();
    const service = serviceFixture({ listAgents: vi.fn(() => pending.promise) });
    const { socket, messages } = await connect(service);
    const request = JSON.stringify({ v: 1, id: "same", type: "list_agents" });

    socket.send(request);
    socket.send(request);
    await expect(messages.next()).resolves.toMatchObject({
      type: "error",
      id: "same",
      error: { code: "duplicate_request" },
    });
    pending.resolve([]);
    await expect(messages.next()).resolves.toMatchObject({ type: "result", id: "same" });
    expect(service.listAgents).toHaveBeenCalledOnce();
  });

  it("cancels a running Service stream when its authenticated client disconnects", async () => {
    let signal: AbortSignal | undefined;
    const service = serviceFixture({
      async *run(_request, runSignal) {
        signal = runSignal;
        yield { type: "started", requestId: "run", sessionId: "session" };
        await aborted(runSignal);
      },
    });
    const { server, socket, messages } = await connect(service);
    socket.send(
      JSON.stringify({
        v: 1,
        id: "run",
        type: "run",
        agentId: "coding",
        sessionId: "session",
        text: "work",
      }),
    );
    await expect(messages.next()).resolves.toMatchObject({ type: "event", requestId: "run" });

    socket.close();
    await expect(server.termination).resolves.toEqual({ reason: "client_disconnected" });
    expect(signal?.aborted).toBe(true);
  });
});

async function connect(service: AgentServicePort): Promise<{
  readonly server: Awaited<ReturnType<typeof startAgentHost>>;
  readonly socket: WebSocket;
  readonly messages: ReturnType<typeof messageQueue>;
}> {
  const token = randomBytes(32).toString("base64url");
  const server = await startAgentHost({ service, token });
  cleanups.push(() => server.close());
  const socket = await new Promise<WebSocket>((resolve, reject) => {
    const candidate = new WebSocket(`ws://${server.address.host}:${server.address.port}/`);
    candidate.once("open", () => resolve(candidate));
    candidate.once("error", reject);
  });
  cleanups.push(() => socket.terminate());
  const messages = messageQueue(socket);
  socket.send(JSON.stringify({ v: 1, type: "hello", token }));
  await messages.next();
  return { server, socket, messages };
}

function messageQueue(socket: WebSocket): { next(): Promise<AgentHostServerMessage> } {
  const pending: ((message: AgentHostServerMessage) => void)[] = [];
  const values: AgentHostServerMessage[] = [];
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString()) as AgentHostServerMessage;
    const resolve = pending.shift();
    if (resolve) resolve(message);
    else values.push(message);
  });
  return {
    next() {
      const value = values.shift();
      return value ? Promise.resolve(value) : new Promise((resolve) => pending.push(resolve));
    },
  };
}

function serviceFixture(overrides: Partial<AgentServicePort> = {}): AgentServicePort {
  return {
    listAgents: vi.fn(async () => []),
    openSession: vi.fn(async (input) => ({
      agentId: input.agentId,
      sessionId: input.sessionId ?? "latest",
    })),
    createSession: vi.fn(async (input) => ({ agentId: input.agentId, sessionId: "created" })),
    closeSession: vi.fn(async () => undefined),
    async *run(request): AsyncIterable<AgentServiceEvent> {
      yield { type: "started", requestId: request.requestId, sessionId: request.sessionId };
      yield { type: "completed" };
    },
    dispose: vi.fn(async () => undefined),
    ...overrides,
  };
}

function aborted(signal: AbortSignal | undefined): Promise<void> {
  if (!signal || signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
