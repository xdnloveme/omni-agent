import {
  AGENT_HOST_MAX_BUFFERED_BYTES,
  AGENT_HOST_MAX_REQUEST_BYTES,
  AGENT_HOST_MAX_RESPONSE_BYTES,
  AGENT_HOST_PROTOCOL_VERSION,
  AgentHostProtocolValidator,
  type AgentHostRequest,
  type AgentHostResult,
  type AgentHostServerMessage,
} from "@omni-agent/agent-host";
import { createAbortError, throwIfAborted } from "@omni-agent/core";
import WebSocket from "ws";
import { isAgentLinkTerminal, type AgentLinkEvent } from "./agent-link-events";

interface PendingRequest {
  readonly resolve: (result: AgentHostResult) => void;
  readonly reject: (error: Error) => void;
}

interface PendingRun {
  readonly stream: AsyncEventStream;
}

export class AgentHostProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "AgentHostProtocolError";
  }
}

export class AgentHostProtocolClient {
  readonly #pendingRequests = new Map<string, PendingRequest>();
  readonly #pendingRuns = new Map<string, PendingRun>();
  readonly #validator = new AgentHostProtocolValidator();
  #socket?: WebSocket;
  #connectPromise?: Promise<void>;
  #sendTail = Promise.resolve();
  #closed = false;

  constructor(
    readonly url: string,
    private readonly token: string,
  ) {}

  connect(): Promise<void> {
    if (this.#closed) {
      return Promise.reject(
        new AgentHostProtocolError("client_closed", "Agent Host client closed"),
      );
    }
    if (this.#socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    this.#connectPromise ??= this.#open().finally(() => {
      this.#connectPromise = undefined;
    });
    return this.#connectPromise;
  }

  async request(request: AgentHostRequest): Promise<AgentHostResult> {
    await this.connect();
    if (request.type === "run") {
      throw new AgentHostProtocolError("invalid_request", "Run requests require stream()");
    }
    return new Promise<AgentHostResult>((resolve, reject) => {
      this.#pendingRequests.set(request.id, { resolve, reject });
      void this.#send(request).catch((error) => {
        this.#pendingRequests.delete(request.id);
        reject(toError(error));
      });
    });
  }

  stream(request: Extract<AgentHostRequest, { type: "run" }>, signal?: AbortSignal) {
    const stream = new AsyncEventStream();
    const start = async () => {
      throwIfAborted(signal);
      await this.connect();
      if (this.#pendingRuns.has(request.id)) {
        throw new AgentHostProtocolError("duplicate_request", `Duplicate request: ${request.id}`);
      }
      this.#pendingRuns.set(request.id, { stream });
      try {
        await this.#send(request);
      } catch (error) {
        this.#pendingRuns.delete(request.id);
        throw error;
      }
    };
    let started = false;
    const onAbort = () => {
      if (!started) {
        stream.fail(createAbortError());
        return;
      }
      void this.cancel(request.id).catch(() => undefined);
    };
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
      stream.setDispose(() => signal.removeEventListener("abort", onAbort));
    }
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<AgentLinkEvent> => {
        const iterator = stream[Symbol.asyncIterator]();
        return {
          next: async () => {
            if (!started) {
              started = true;
              try {
                await start();
              } catch (error) {
                stream.fail(toError(error));
              }
            }
            return iterator.next();
          },
          return: async () => {
            signal?.removeEventListener("abort", onAbort);
            if (this.#pendingRuns.delete(request.id)) {
              await this.cancel(request.id).catch(() => undefined);
            }
            stream.finish();
            return { done: true, value: undefined };
          },
        };
      },
    };
  }

  async cancel(requestId: string): Promise<void> {
    const id = crypto.randomUUID();
    const result = await this.request({
      v: AGENT_HOST_PROTOCOL_VERSION,
      id,
      type: "cancel",
      requestId,
    });
    if (result.kind !== "cancel_requested" || result.requestId !== requestId) {
      throw new AgentHostProtocolError("invalid_response", "Agent Host cancel response is invalid");
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const socket = this.#socket;
    this.#socket = undefined;
    this.#failPending("client_closed", "Agent Host client closed");
    await this.#sendTail;
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        socket.terminate();
        resolve();
      }, 1_000);
      socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.close(1000, "Gateway closing");
    });
  }

  async #open(): Promise<void> {
    const socket = new WebSocket(this.url, {
      maxPayload: AGENT_HOST_MAX_RESPONSE_BYTES,
      handshakeTimeout: 5_000,
    });
    this.#socket = socket;
    await new Promise<void>((resolve, reject) => {
      let authenticated = false;
      const timer = setTimeout(() => {
        socket.terminate();
        reject(
          new AgentHostProtocolError("connect_timeout", "Agent Host handshake timed out", true),
        );
      }, 5_000);
      const cleanup = () => clearTimeout(timer);
      socket.on("message", (data, isBinary) => {
        if (isBinary) {
          socket.close(1002, "Binary messages are unsupported");
          return;
        }
        let message: AgentHostServerMessage;
        try {
          message = this.#validator.parseServerMessage(data.toString());
        } catch (error) {
          socket.close(1002, "Invalid server message");
          if (!authenticated) reject(error);
          return;
        }
        if (!authenticated) {
          if (message.type !== "ready") {
            cleanup();
            reject(
              new AgentHostProtocolError("invalid_handshake", "Agent Host did not send ready"),
            );
            socket.close(1002, "Expected ready");
            return;
          }
          authenticated = true;
          cleanup();
          resolve();
          return;
        }
        this.#handleMessage(message);
      });
      socket.once("open", () => {
        void this.#send({
          v: AGENT_HOST_PROTOCOL_VERSION,
          type: "hello",
          token: this.token,
        }).catch(reject);
      });
      socket.once("error", (error) => {
        cleanup();
        if (!authenticated) reject(error);
      });
      socket.once("close", () => {
        cleanup();
        if (!authenticated) {
          reject(
            new AgentHostProtocolError(
              "connection_closed",
              "Agent Host closed during handshake",
              true,
            ),
          );
        }
        if (this.#socket === socket) this.#socket = undefined;
        this.#failPending("connection_closed", "Agent Host connection closed");
      });
    });
  }

  #handleMessage(message: AgentHostServerMessage): void {
    if (message.type === "ready") return;
    if (message.type === "event") {
      const pending = this.#pendingRuns.get(message.requestId);
      if (!pending) return;
      pending.stream.push(message.event);
      if (isAgentLinkTerminal(message.event)) {
        this.#pendingRuns.delete(message.requestId);
        pending.stream.dispose();
        pending.stream.finish();
      }
      return;
    }
    if (message.type === "result") {
      const pending = this.#pendingRequests.get(message.id);
      if (!pending) return;
      this.#pendingRequests.delete(message.id);
      pending.resolve(message.result);
      return;
    }
    if (message.id) {
      const request = this.#pendingRequests.get(message.id);
      if (request) {
        this.#pendingRequests.delete(message.id);
        request.reject(
          new AgentHostProtocolError(
            message.error.code,
            message.error.message,
            message.error.retryable,
          ),
        );
        return;
      }
      const run = this.#pendingRuns.get(message.id);
      if (run) {
        this.#pendingRuns.delete(message.id);
        run.stream.push({ type: "failed", ...message.error });
        run.stream.finish();
      }
    }
  }

  #send(message: object): Promise<void> {
    let payload: string;
    try {
      payload = JSON.stringify(message);
    } catch {
      return Promise.reject(new AgentHostProtocolError("invalid_message", "Message is not JSON"));
    }
    if (Buffer.byteLength(payload, "utf8") > AGENT_HOST_MAX_REQUEST_BYTES) {
      return Promise.reject(
        new AgentHostProtocolError("payload_too_large", "Agent Host message exceeds 64 KiB"),
      );
    }
    const operation = this.#sendTail.then(() => {
      const socket = this.#socket;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        throw new AgentHostProtocolError("connection_closed", "Agent Host connection closed", true);
      }
      if (
        socket.bufferedAmount + Buffer.byteLength(payload, "utf8") >
        AGENT_HOST_MAX_BUFFERED_BYTES
      ) {
        throw new AgentHostProtocolError(
          "host_busy",
          "Agent Host client write buffer is full",
          true,
        );
      }
      return new Promise<void>((resolve, reject) =>
        socket.send(payload, (error) => (error ? reject(error) : resolve())),
      );
    });
    this.#sendTail = operation.catch(() => undefined);
    return operation;
  }

  #failPending(code: string, message: string): void {
    const error = new AgentHostProtocolError(code, message, true);
    for (const pending of this.#pendingRequests.values()) pending.reject(error);
    this.#pendingRequests.clear();
    for (const pending of this.#pendingRuns.values()) {
      pending.stream.push({ type: "unknown", message });
      pending.stream.dispose();
      pending.stream.finish();
    }
    this.#pendingRuns.clear();
  }
}

class AsyncEventStream implements AsyncIterable<AgentLinkEvent> {
  readonly #events: AgentLinkEvent[] = [];
  readonly #reads: {
    resolve: (value: IteratorResult<AgentLinkEvent>) => void;
    reject: (reason?: unknown) => void;
  }[] = [];
  #finished = false;
  #error?: Error;
  #dispose?: () => void;

  setDispose(dispose: () => void): void {
    this.#dispose = dispose;
  }

  dispose(): void {
    this.#dispose?.();
    this.#dispose = undefined;
  }

  push(event: AgentLinkEvent): void {
    if (this.#finished) return;
    const read = this.#reads.shift();
    if (read) read.resolve({ done: false, value: event });
    else this.#events.push(event);
  }

  fail(error: Error): void {
    if (this.#finished) return;
    this.dispose();
    this.#error = error;
    this.#finished = true;
    for (const read of this.#reads.splice(0)) read.reject(error);
  }

  finish(): void {
    if (this.#finished) return;
    this.dispose();
    this.#finished = true;
    if (this.#events.length === 0) {
      for (const read of this.#reads.splice(0)) read.resolve({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentLinkEvent> {
    return {
      next: () => {
        const event = this.#events.shift();
        if (event) return Promise.resolve({ done: false, value: event });
        if (this.#error) return Promise.reject(this.#error);
        if (this.#finished) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve, reject) => this.#reads.push({ resolve, reject }));
      },
    };
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
