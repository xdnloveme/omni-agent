import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentServiceEvent, AgentServicePort, AgentServiceRunRequest } from "@omni-agent/app";
import WebSocket from "ws";
import { AGENT_HOST_MAX_BUFFERED_BYTES, type AgentHostServerMessage } from "../contracts";
import { startAgentHost } from "../websocket-agent-host";

const openServers: Awaited<ReturnType<typeof startAgentHost>>[] = [];
const openSockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of openSockets.splice(0)) socket.terminate();
  await Promise.allSettled(openServers.splice(0).map((server) => server.close()));
});

describe("WebSocket Agent Host", () => {
  it("authenticates on loopback and forwards requests only through AgentServicePort", async () => {
    const service = serviceFixture();
    const { server, socket, messages } = await connect(service);

    expect(server.address.host).toBe("127.0.0.1");
    socket.send(JSON.stringify({ v: 2, id: "list", type: "list_agents" }));
    await expect(messages.next()).resolves.toEqual(
      expect.objectContaining({
        type: "result",
        id: "list",
        result: { kind: "agents", agents: [expect.objectContaining({ id: "coding" })] },
      }),
    );
    expect(service.listAgents).toHaveBeenCalledOnce();

    socket.close();
    await expect(server.termination).resolves.toEqual({ reason: "client_disconnected" });
    expect(service.dispose).not.toHaveBeenCalled();
  });

  it("maps Run input exactly and cancels it through the connection-owned signal", async () => {
    let receivedRequest: AgentServiceRunRequest | undefined;
    let receivedSignal: AbortSignal | undefined;
    const service = serviceFixture({
      async *run(request, signal) {
        receivedRequest = request;
        receivedSignal = signal;
        yield { type: "started", requestId: request.requestId, sessionId: request.sessionId };
        await aborted(signal);
        yield { type: "cancelled" };
      },
    });
    const { socket, messages } = await connect(service);

    socket.send(
      JSON.stringify({
        v: 2,
        id: "run-1",
        type: "run",
        agentId: "coding",
        sessionId: "session-1",
        text: "do work",
      }),
    );
    await expect(messages.next()).resolves.toMatchObject({
      type: "event",
      requestId: "run-1",
      event: { type: "started" },
    });
    socket.send(JSON.stringify({ v: 2, id: "cancel-1", type: "cancel", requestId: "run-1" }));
    const terminalMessages = await Promise.all([messages.next(), messages.next()]);

    expect(terminalMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "result",
          id: "cancel-1",
          result: { kind: "cancel_requested", requestId: "run-1" },
        }),
        expect.objectContaining({
          type: "event",
          requestId: "run-1",
          event: { type: "cancelled" },
        }),
      ]),
    );
    expect(receivedRequest).toEqual({
      requestId: "run-1",
      agentId: "coding",
      sessionId: "session-1",
      input: { type: "text", text: "do work" },
    });
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("aborts the Run and closes the Host when outbound backpressure is exceeded", async () => {
    let receivedSignal: AbortSignal | undefined;
    const service = serviceFixture({
      async *run(request, signal) {
        receivedSignal = signal;
        yield { type: "started", requestId: request.requestId, sessionId: request.sessionId };
        yield { type: "text_delta", text: "x".repeat(AGENT_HOST_MAX_BUFFERED_BYTES) };
      },
    });
    const { server, socket, messages } = await connect(service);

    socket.send(
      JSON.stringify({
        v: 2,
        id: "run-with-backpressure",
        type: "run",
        agentId: "coding",
        sessionId: "session-1",
        text: "produce a large response",
      }),
    );
    await expect(messages.next()).resolves.toMatchObject({
      type: "event",
      requestId: "run-with-backpressure",
      event: { type: "started" },
    });

    await socketClosed(socket);
    await expect(server.termination).resolves.toEqual({ reason: "closed" });
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("rejects invalid authentication without exposing the Service and still accepts the owner", async () => {
    const service = serviceFixture();
    const token = randomBytes(32).toString("base64url");
    const server = await startAgentHost({ service, token });
    openServers.push(server);
    const socket = await openSocket(server);
    openSockets.push(socket);

    socket.send(
      JSON.stringify({ v: 2, type: "hello", token: randomBytes(32).toString("base64url") }),
    );
    await socketClosed(socket);

    expect(service.listAgents).not.toHaveBeenCalled();
    const owner = await openSocket(server);
    openSockets.push(owner);
    const messages = messageQueue(owner);
    owner.send(JSON.stringify({ v: 2, type: "hello", token }));
    await expect(messages.next()).resolves.toMatchObject({ type: "ready" });
    owner.send(JSON.stringify({ v: 2, id: "list", type: "list_agents" }));
    await expect(messages.next()).resolves.toMatchObject({ type: "result", id: "list" });
    expect(service.listAgents).toHaveBeenCalledOnce();
  });

  it("rejects a second client after the owner authenticates", async () => {
    const service = serviceFixture();
    const { server } = await connect(service);

    await expect(openSocket(server)).rejects.toThrow();
    expect(service.listAgents).not.toHaveBeenCalled();
  });

  it("keeps Service disposal with the Composition Root", async () => {
    const service = serviceFixture();
    const token = randomBytes(32).toString("base64url");
    const server = await startAgentHost({ service, token });
    openServers.push(server);

    const first = server.close();
    const second = server.close();
    await Promise.all([first, second]);

    expect(service.dispose).not.toHaveBeenCalled();
    await expect(server.termination).resolves.toEqual({ reason: "closed" });
  });
});

async function connect(service: AgentServicePort): Promise<{
  readonly server: Awaited<ReturnType<typeof startAgentHost>>;
  readonly socket: WebSocket;
  readonly messages: ReturnType<typeof messageQueue>;
}> {
  const token = randomBytes(32).toString("base64url");
  const server = await startAgentHost({ service, token });
  openServers.push(server);
  const socket = await openSocket(server);
  openSockets.push(socket);
  const messages = messageQueue(socket);
  socket.send(JSON.stringify({ v: 2, type: "hello", token }));
  await expect(messages.next()).resolves.toMatchObject({ type: "ready", v: 2 });
  return { server, socket, messages };
}

function openSocket(server: Awaited<ReturnType<typeof startAgentHost>>): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://${server.address.host}:${server.address.port}/`);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
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
      if (value) return Promise.resolve(value);
      return new Promise((resolve) => pending.push(resolve));
    },
  };
}

function socketClosed(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => socket.once("close", () => resolve()));
}

function aborted(signal: AbortSignal | undefined): Promise<void> {
  if (!signal || signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}

function serviceFixture(
  overrides: Partial<AgentServicePort> = {},
): AgentServicePort & { readonly dispose: ReturnType<typeof vi.fn> } {
  const dispose = vi.fn(async () => undefined);
  return {
    listAgents: vi.fn(async () => [
      {
        id: "coding",
        displayName: "Coding Agent",
        description: "Coding",
        packageName: "@omni-agent/agent-coding",
        packageVersion: "0.0.1",
      },
    ]),
    openSession: vi.fn(async (input) => ({
      agentId: input.agentId,
      sessionId: input.sessionId ?? "latest",
    })),
    createSession: vi.fn(async (input) => ({ agentId: input.agentId, sessionId: "new" })),
    closeSession: vi.fn(async () => undefined),
    async *run(request): AsyncIterable<AgentServiceEvent> {
      yield { type: "started", requestId: request.requestId, sessionId: request.sessionId };
      yield { type: "completed" };
    },
    ...overrides,
    dispose,
  } as AgentServicePort & { readonly dispose: ReturnType<typeof vi.fn> };
}
