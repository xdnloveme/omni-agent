import { timingSafeEqual } from "node:crypto";
import type { AgentServicePort } from "@omni-agent/app";
import { toAgentServiceFailure } from "@omni-agent/app";
import WebSocket, { type RawData } from "ws";
import { AGENT_HOST_PROTOCOL_VERSION, type AgentHostRequest } from "./contracts";
import { AgentHostError, toAgentHostFailure } from "./host-error";
import { OutboundWriter } from "./outbound-writer";
import { AgentHostProtocolValidator } from "./protocol-validator";

const AUTHENTICATION_TIMEOUT_MS = 5_000;
const HEARTBEAT_INTERVAL_MS = 30_000;

export interface AgentHostConnectionOptions {
  readonly socket: WebSocket;
  readonly service: AgentServicePort;
  readonly expectedToken: Buffer;
  readonly connectionId: string;
  readonly onAuthenticated: () => void;
  readonly onClosed: (authenticated: boolean, peerDisconnected: boolean) => void;
}

export class AgentHostConnection {
  readonly #socket: WebSocket;
  readonly #service: AgentServicePort;
  readonly #expectedToken: Buffer;
  readonly #connectionId: string;
  readonly #onAuthenticated: () => void;
  readonly #onClosed: (authenticated: boolean, peerDisconnected: boolean) => void;
  readonly #validator = new AgentHostProtocolValidator();
  readonly #writer: OutboundWriter;
  readonly #activeRequestIds = new Set<string>();
  readonly #runControllers = new Map<string, AbortController>();
  readonly #handlers = new Set<Promise<void>>();
  readonly #socketClosed: Promise<void>;
  #resolveSocketClosed!: () => void;
  #authenticationTimer: ReturnType<typeof setTimeout> | undefined;
  #heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  #authenticated = false;
  #heartbeatAlive = true;
  #hostInitiatedClose = false;
  #peerDisconnected = false;
  #closing = false;
  #closePromise: Promise<void> | undefined;
  #detachPermissions: (() => void) | undefined;

  constructor(options: AgentHostConnectionOptions) {
    this.#socket = options.socket;
    this.#service = options.service;
    this.#expectedToken = options.expectedToken;
    this.#connectionId = options.connectionId;
    this.#onAuthenticated = options.onAuthenticated;
    this.#onClosed = options.onClosed;
    this.#writer = new OutboundWriter(this.#socket);
    this.#socketClosed = new Promise((resolve) => {
      this.#resolveSocketClosed = resolve;
    });
  }

  start(): void {
    this.#socket.on("message", this.#handleMessage);
    this.#socket.on("pong", this.#handlePong);
    this.#socket.once("close", this.#handleSocketClosed);
    this.#socket.once("error", this.#handleSocketError);
    this.#authenticationTimer = setTimeout(() => {
      void this.close(1008, "Authentication timeout").catch(() => undefined);
    }, AUTHENTICATION_TIMEOUT_MS);
    this.#authenticationTimer.unref?.();
  }

  close(code = 1001, reason = "Agent Host closing"): Promise<void> {
    this.#hostInitiatedClose = true;
    if (this.#closePromise) return this.#closePromise;
    this.#closePromise = this.#close(code, reason);
    return this.#closePromise;
  }

  readonly #handleMessage = (data: RawData, isBinary: boolean): void => {
    if (this.#closing) return;
    if (isBinary) {
      void this.close(1003, "Binary messages are not supported").catch(() => undefined);
      return;
    }
    const raw = rawDataToText(data);
    if (!this.#authenticated) {
      void this.#authenticate(raw).catch(() => undefined);
      return;
    }
    let request: AgentHostRequest;
    try {
      const message = this.#validator.parse(raw);
      if (message.type === "hello") {
        throw new AgentHostError("invalid_message", "Agent Host message is invalid");
      }
      request = message;
    } catch (error) {
      this.#track(this.#sendError(undefined, error));
      if (error instanceof AgentHostError && error.code === "unsupported_version") {
        void this.close(1002, "Unsupported protocol version").catch(() => undefined);
      }
      return;
    }
    if (this.#activeRequestIds.has(request.id)) {
      this.#track(
        this.#sendError(
          request.id,
          new AgentHostError("duplicate_request", "Agent Host request is already active"),
        ),
      );
      return;
    }
    this.#activeRequestIds.add(request.id);
    this.#track(this.#dispatch(request));
  };

  readonly #handlePong = (): void => {
    this.#heartbeatAlive = true;
  };

  readonly #handleSocketClosed = (): void => {
    this.#resolveSocketClosed();
    if (!this.#closePromise) {
      this.#peerDisconnected = !this.#hostInitiatedClose;
      void this.close().catch(() => undefined);
    }
  };

  readonly #handleSocketError = (): void => {
    if (!this.#closePromise) {
      void this.close(1011, "WebSocket failure").catch(() => undefined);
    }
  };

  async #authenticate(raw: string): Promise<void> {
    try {
      const message = this.#validator.parse(raw);
      if (message.type !== "hello" || !matchesToken(message.token, this.#expectedToken)) {
        throw new AgentHostError("unauthorized", "Agent Host authentication failed");
      }
      if (this.#closing || this.#authenticated) return;
      this.#authenticated = true;
      if (this.#authenticationTimer) clearTimeout(this.#authenticationTimer);
      this.#authenticationTimer = undefined;
      this.#onAuthenticated();
      this.#detachPermissions = this.#service.subscribePermissions?.((event) => {
        if (event.type === "requested") {
          const { type: _type, ...payload } = event;
          return this.#writer.send({
            v: AGENT_HOST_PROTOCOL_VERSION,
            type: "permission.requested",
            ...payload,
          });
        }
        const { type: _type, ...payload } = event;
        return this.#writer.send({
          v: AGENT_HOST_PROTOCOL_VERSION,
          type: "permission.resolved",
          ...payload,
        });
      });
      await this.#writer.send({
        v: AGENT_HOST_PROTOCOL_VERSION,
        type: "ready",
        connectionId: this.#connectionId,
      });
      if (!this.#closing) this.#startHeartbeat();
    } catch (error) {
      const closeCode =
        error instanceof AgentHostError && error.code === "unsupported_version" ? 1002 : 1008;
      await this.close(closeCode, "Agent Host authentication failed");
    }
  }

  async #dispatch(request: AgentHostRequest): Promise<void> {
    try {
      switch (request.type) {
        case "list_agents":
          await this.#writer.send({
            v: 2,
            type: "result",
            id: request.id,
            result: { kind: "agents", agents: await this.#service.listAgents() },
          });
          return;
        case "open_session":
          await this.#writer.send({
            v: 2,
            type: "result",
            id: request.id,
            result: {
              kind: "session",
              session: await this.#service.openSession({
                agentId: request.agentId,
                ...(request.sessionId ? { sessionId: request.sessionId } : {}),
              }),
            },
          });
          return;
        case "create_session":
          await this.#writer.send({
            v: 2,
            type: "result",
            id: request.id,
            result: {
              kind: "session",
              session: await this.#service.createSession({ agentId: request.agentId }),
            },
          });
          return;
        case "close_session":
          await this.#service.closeSession({
            agentId: request.agentId,
            sessionId: request.sessionId,
          });
          await this.#writer.send({
            v: 2,
            type: "result",
            id: request.id,
            result: { kind: "closed" },
          });
          return;
        case "cancel": {
          const controller = this.#runControllers.get(request.requestId);
          if (!controller) {
            throw new AgentHostError("request_not_active", "Agent Host Run request is not active");
          }
          controller.abort();
          await this.#writer.send({
            v: 2,
            type: "result",
            id: request.id,
            result: { kind: "cancel_requested", requestId: request.requestId },
          });
          return;
        }
        case "resolve_permission": {
          if (!this.#service.resolvePermission?.(request.permissionId, request.decision)) {
            throw new AgentHostError(
              "request_not_active",
              "Agent Host permission request is not active",
            );
          }
          await this.#writer.send({
            v: AGENT_HOST_PROTOCOL_VERSION,
            type: "result",
            id: request.id,
            result: { kind: "permission_resolved", permissionId: request.permissionId },
          });
          return;
        }
        case "run":
          await this.#run(request);
          return;
      }
    } catch (error) {
      if (error instanceof AgentHostError && error.code === "host_busy") {
        void this.close(1013, "Agent Host backpressure exceeded").catch(() => undefined);
        return;
      }
      if (!this.#closing) await this.#sendError(request.id, error);
    } finally {
      this.#activeRequestIds.delete(request.id);
    }
  }

  async #run(request: Extract<AgentHostRequest, { readonly type: "run" }>): Promise<void> {
    const controller = new AbortController();
    this.#runControllers.set(request.id, controller);
    try {
      const events = this.#service.run(
        {
          requestId: request.id,
          agentId: request.agentId,
          sessionId: request.sessionId,
          input: { type: "text", text: request.text },
        },
        controller.signal,
      );
      for await (const event of events) {
        await this.#writer.send({
          v: 2,
          type: "event",
          requestId: request.id,
          event,
        });
      }
    } catch (error) {
      if (error instanceof AgentHostError && error.code === "host_busy") controller.abort();
      throw error;
    } finally {
      this.#runControllers.delete(request.id);
    }
  }

  async #sendError(id: string | undefined, error: unknown): Promise<void> {
    if (this.#closing) return;
    const failure =
      error instanceof AgentHostError ? toAgentHostFailure(error) : toAgentServiceFailure(error);
    try {
      await this.#writer.send({
        v: 2,
        type: "error",
        ...(id ? { id } : {}),
        error: failure,
      });
    } catch {
      // Do not await close from inside an active handler: the close barrier waits for handlers.
      void this.close(1011, "Agent Host write failed").catch(() => undefined);
    }
  }

  #track(handler: Promise<void>): void {
    this.#handlers.add(handler);
    void handler
      .catch(() => {
        void this.close(1011, "Agent Host request failed").catch(() => undefined);
      })
      .finally(() => this.#handlers.delete(handler));
  }

  #startHeartbeat(): void {
    this.#heartbeatTimer = setInterval(() => {
      if (!this.#heartbeatAlive) {
        this.#hostInitiatedClose = true;
        this.#socket.terminate();
        return;
      }
      this.#heartbeatAlive = false;
      this.#socket.ping();
    }, HEARTBEAT_INTERVAL_MS);
    this.#heartbeatTimer.unref?.();
  }

  async #close(code: number, reason: string): Promise<void> {
    const authenticated = this.#authenticated;
    const failures: unknown[] = [];
    this.#closing = true;
    if (this.#authenticationTimer) clearTimeout(this.#authenticationTimer);
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    this.#authenticationTimer = undefined;
    this.#heartbeatTimer = undefined;
    this.#socket.off("message", this.#handleMessage);
    this.#socket.off("pong", this.#handlePong);
    for (const controller of this.#runControllers.values()) controller.abort();
    this.#detachPermissions?.();
    this.#detachPermissions = undefined;
    try {
      await this.#writer.close();
    } catch (error) {
      failures.push(error);
    }
    await Promise.allSettled([...this.#handlers]);
    try {
      if (this.#socket.readyState === WebSocket.OPEN) this.#socket.close(code, reason);
      else if (this.#socket.readyState === WebSocket.CONNECTING) this.#socket.terminate();
      if (this.#socket.readyState !== WebSocket.CLOSED) await this.#socketClosed;
    } catch (error) {
      failures.push(error);
    } finally {
      this.#onClosed(authenticated, this.#peerDisconnected);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Failed to close Agent Host connection");
    }
  }
}

export function decodeAgentHostToken(token: string): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
  const decoded = Buffer.from(token, "base64url");
  if (decoded.byteLength !== 32 || decoded.toString("base64url") !== token) return undefined;
  return decoded;
}

function matchesToken(token: string, expected: Buffer): boolean {
  const decoded = decodeAgentHostToken(token);
  return Boolean(decoded && timingSafeEqual(decoded, expected));
}

function rawDataToText(data: RawData): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return data.toString("utf8");
}
