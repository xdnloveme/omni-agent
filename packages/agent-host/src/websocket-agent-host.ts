import { randomUUID } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import {
  AGENT_HOST_LISTEN_ADDRESS,
  AGENT_HOST_MAX_REQUEST_BYTES,
  type AgentHostOptions,
  type AgentHostServer,
  type AgentHostTermination,
} from "./contracts";
import { AgentHostConnection, decodeAgentHostToken } from "./connection-runtime";
import { AgentHostError } from "./host-error";

type HostState = "starting" | "listening" | "closing" | "closed";

export async function startAgentHost(options: AgentHostOptions): Promise<AgentHostServer> {
  const expectedToken = decodeAgentHostToken(options.token);
  if (!expectedToken) {
    throw new AgentHostError("unauthorized", "Agent Host token is invalid");
  }
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new AgentHostError("invalid_message", "Agent Host port is invalid");
  }

  const httpServer = createServer((_request, response) => {
    response.writeHead(404, { "Cache-Control": "no-store", "Content-Type": "text/plain" });
    response.end("Not found");
  });
  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: AGENT_HOST_MAX_REQUEST_BYTES,
    perMessageDeflate: false,
  });
  let state: HostState = "starting";
  let connection: AgentHostConnection | undefined;
  let authenticated = false;
  let closePromise: Promise<void> | undefined;
  let resolveTermination!: (termination: AgentHostTermination) => void;
  const termination = new Promise<AgentHostTermination>((resolve) => {
    resolveTermination = resolve;
  });

  await listen(httpServer, port);
  const address = httpServer.address();
  if (!address || typeof address === "string") {
    await closeHttpServer(httpServer);
    throw new Error("Agent Host server did not bind to a TCP address");
  }
  state = "listening";
  const expectedHost = `${AGENT_HOST_LISTEN_ADDRESS}:${address.port}`;

  httpServer.on("upgrade", (request, socket, head) => {
    if (state !== "listening" || authenticated || connection) {
      rejectUpgrade(socket, 409, "Agent Host is busy");
      return;
    }
    if (request.headers.host !== expectedHost || request.url !== "/") {
      rejectUpgrade(socket, 400, "Invalid Agent Host upgrade");
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit("connection", webSocket, request);
    });
  });

  webSocketServer.on("connection", (socket) => {
    const current = new AgentHostConnection({
      socket,
      service: options.service,
      expectedToken,
      connectionId: randomUUID(),
      onAuthenticated() {
        authenticated = true;
      },
      onClosed(wasAuthenticated, peerDisconnected) {
        if (connection === current) connection = undefined;
        if (wasAuthenticated && state === "listening") {
          const reason: AgentHostTermination = peerDisconnected
            ? { reason: "client_disconnected" }
            : { reason: "closed" };
          void shutdown(reason).catch(() => undefined);
        }
      },
    });
    connection = current;
    current.start();
  });
  httpServer.on("error", () => {
    if (state === "listening") void shutdown({ reason: "closed" }).catch(() => undefined);
  });
  webSocketServer.on("error", () => {
    if (state === "listening") void shutdown({ reason: "closed" }).catch(() => undefined);
  });

  async function shutdown(reason: AgentHostTermination): Promise<void> {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      const failures: unknown[] = [];
      state = "closing";
      const activeConnection = connection;
      connection = undefined;
      try {
        await activeConnection?.close();
      } catch (error) {
        failures.push(error);
      }
      try {
        await closeWebSocketServer(webSocketServer);
      } catch (error) {
        failures.push(error);
      }
      try {
        await closeHttpServer(httpServer);
      } catch (error) {
        failures.push(error);
      }
      state = "closed";
      resolveTermination(reason);
      if (failures.length > 0) {
        throw new AggregateError(failures, "Failed to close Agent Host server");
      }
    })();
    return closePromise;
  }

  return {
    address: { host: AGENT_HOST_LISTEN_ADDRESS, port: address.port },
    termination,
    close: () => shutdown({ reason: "closed" }),
  };
}

function listen(server: HttpServer, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, AGENT_HOST_LISTEN_ADDRESS);
  });
}

function closeHttpServer(server: HttpServer): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  socket.end(
    `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: 0\r\n\r\n`,
  );
}
