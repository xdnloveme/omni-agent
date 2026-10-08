import { randomBytes } from "node:crypto";
import http from "node:http";
import type { Socket } from "node:net";
import { addAbortSignal } from "node:stream";
import {
  throwIfAborted,
  type NetworkCapability,
  type NetworkProxyRoute,
  type NetworkRequest,
} from "@omni-agent/core";
import { NetworkPolicyError } from "./error";
import { NetworkGateway } from "./gateway";

export interface ProxyLease {
  readonly route: NetworkProxyRoute;
  readonly sensitiveValues: readonly string[];
  close(): Promise<void>;
}

const HTTP_METHODS = new Set<NetworkRequest["method"]>([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]);
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;

export async function openCapabilityProxy(
  gateway: NetworkGateway,
  capability: NetworkCapability,
  options: { readonly ttlMs?: number } = {},
): Promise<ProxyLease> {
  const ttlMs = options.ttlMs ?? 30 * 60_000;
  if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > 30 * 60_000)
    throw new Error("Invalid network proxy TTL");
  const token = randomBytes(32).toString("base64url");
  const expected = `Basic ${Buffer.from(`omni:${token}`).toString("base64")}`;
  const lifetime = new AbortController();
  const network = gateway.client(capability, "autonomous");
  const sockets = new Set<Socket>();
  const server = http.createServer(async (request, response) => {
    if (request.headers["proxy-authorization"] !== expected) {
      response.writeHead(407, { "proxy-authenticate": "Basic realm=omni" }).end();
      return;
    }
    const method = request.method as NetworkRequest["method"];
    if (!HTTP_METHODS.has(method) || !request.url) {
      response.writeHead(405).end();
      return;
    }
    const downstream = new AbortController();
    response.once("close", () => downstream.abort());
    const signal = AbortSignal.any([lifetime.signal, downstream.signal]);
    try {
      addAbortSignal(signal, request);
      const chunks: Buffer[] = [];
      let receivedBytes = 0;
      // Buffer only a bounded payload; rejected uploads must never reach the upstream.
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        receivedBytes += chunk.length;
        if (receivedBytes > MAX_REQUEST_BYTES) {
          response.writeHead(413, { connection: "close" }).end();
          return;
        }
        chunks.push(chunk);
      }
      throwIfAborted(signal);
      const upstream = await network.request({
        url: request.url,
        method,
        body: Buffer.concat(chunks),
        headers: { ...forwardHeaders(request.headers), "content-length": String(receivedBytes) },
        maxCompressedBytes: 8 * 1024 * 1024,
        maxDecompressedBytes: 16 * 1024 * 1024,
        signal,
      });
      throwIfAborted(signal);
      response.writeHead(upstream.status, forwardHeaders(upstream.headers));
      response.end(upstream.body);
    } catch {
      if (!response.destroyed) response.writeHead(403).end();
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("connect", async (request, client, head) => {
    client.on("error", () => undefined);
    if (request.headers["proxy-authorization"] !== expected) {
      client.end(
        "HTTP/1.1 407 Proxy Authentication Required\r\n" +
          "Proxy-Authenticate: Basic realm=omni\r\n" +
          "Content-Length: 0\r\n\r\n",
      );
      return;
    }
    const authority = parseAuthority(request.url);
    if (!authority) {
      client.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const downstream = new AbortController();
    client.once("close", () => downstream.abort());
    const signal = AbortSignal.any([lifetime.signal, downstream.signal]);
    try {
      const upstream = await gateway.connectTlsTarget(
        capability,
        authority.host,
        authority.port,
        signal,
      );
      if (signal.aborted) {
        upstream.destroy();
        return;
      }
      sockets.add(upstream);
      upstream.once("close", () => {
        sockets.delete(upstream);
        client.destroy();
      });
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    } catch {
      client.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Network proxy did not bind TCP");
  const url = `http://omni:${token}@127.0.0.1:${address.port}`;
  let closePromise: Promise<void> | undefined;
  const closeProxy = () =>
    (closePromise ??= new Promise<void>((resolve) => {
      lifetime.abort(
        new NetworkPolicyError("network_capability_expired", "Network capability expired"),
      );
      for (const socket of sockets) socket.destroy();
      if (!server.listening) resolve();
      else server.close(() => resolve());
    }));
  const expiry = setTimeout(() => void closeProxy(), ttlMs);
  expiry.unref?.();
  return {
    route: { host: "127.0.0.1", port: address.port, url },
    sensitiveValues: [token, url, expected],
    async close() {
      clearTimeout(expiry);
      await closeProxy();
    },
  };
}

function forwardHeaders(headers: http.IncomingHttpHeaders): Record<string, string | string[]> {
  const forwarded: Record<string, string | string[]> = {};
  const connectionHeaders = new Set(
    (headers.connection ?? "")
      .toLowerCase()
      .split(",")
      .map((name) => name.trim()),
  );
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (
      value === undefined ||
      normalized === "proxy-authorization" ||
      normalized === "proxy-connection" ||
      normalized === "connection" ||
      normalized === "keep-alive" ||
      normalized === "transfer-encoding" ||
      normalized === "te" ||
      normalized === "trailer" ||
      normalized === "upgrade" ||
      connectionHeaders.has(normalized) ||
      normalized === "host"
    ) {
      continue;
    }
    forwarded[normalized] = value;
  }
  return forwarded;
}

function parseAuthority(value: string | undefined): { host: string; port: number } | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(`https://${value}`);
    if (url.username || url.password || url.pathname !== "/") return undefined;
    const port = url.port ? Number(url.port) : 443;
    if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
    return { host: url.hostname, port };
  } catch {
    return undefined;
  }
}
