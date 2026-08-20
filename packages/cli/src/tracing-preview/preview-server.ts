import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TraceQueryPort } from "@omni-agent/app";
import { assertTraceId } from "@omni-agent/core";

const POLL_MS = 300;

export interface PreviewServer {
  readonly url: string;
  close(): Promise<void>;
}

export async function createPreviewServer(query: TraceQueryPort): Promise<PreviewServer> {
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer(async (request, response) => {
    secure(response);
    try {
      if (!validHost(request.headers.host)) return json(response, 400, { error: "Invalid Host" });
      if (request.method !== "GET" && request.method !== "HEAD") {
        return json(response, 405, { error: "Method not allowed" });
      }
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/") return asset(response, "index.html", "text/html; charset=utf-8");
      if (url.pathname === "/app.js") {
        return asset(response, "app.js", "text/javascript; charset=utf-8");
      }
      if (url.pathname === "/view-model.js") {
        return asset(response, "view-model.js", "text/javascript; charset=utf-8");
      }
      if (url.pathname === "/styles.css") {
        return asset(response, "styles.css", "text/css; charset=utf-8");
      }
      if (url.pathname === "/api/agent") {
        return json(response, 200, {
          ...query.agent(),
          diskUsage: await query.diskUsage(),
        });
      }
      if (url.pathname === "/api/sessions") return json(response, 200, await query.sessions());
      if (url.pathname === "/api/live") {
        return liveActivity(request, response, query, discoveryCursor(request, url));
      }
      const sessionRuns = /^\/api\/sessions\/([^/]+)\/runs$/.exec(url.pathname);
      if (sessionRuns) return json(response, 200, await query.runs(sessionRuns[1]!));
      const run = /^\/api\/runs\/([^/]+)$/.exec(url.pathname);
      if (run) {
        const sessionId = required(url, "sessionId");
        return json(response, 200, await query.run(sessionId, run[1]!));
      }
      const spans = /^\/api\/runs\/([^/]+)\/spans$/.exec(url.pathname);
      if (spans) {
        return json(response, 200, await query.spanSnapshot(required(url, "sessionId"), spans[1]!));
      }
      const replay = /^\/api\/runs\/([^/]+)\/replay$/.exec(url.pathname);
      if (replay) {
        return json(
          response,
          200,
          await query.replayChunk(
            required(url, "sessionId"),
            replay[1]!,
            cursor(request, url),
            limit(url),
          ),
        );
      }
      const payload = /^\/api\/runs\/([^/]+)\/payloads\/([^/]+)$/.exec(url.pathname);
      if (payload) {
        const parts = Number(url.searchParams.get("parts"));
        if (!Number.isInteger(parts) || parts < 1 || parts > 100_000) {
          throw new Error("Invalid payload parts");
        }
        return streamPayload(
          request,
          response,
          query.payloadParts(required(url, "sessionId"), payload[1]!, {
            payloadId: payload[2]!,
            parts,
            encoding: "utf8-json",
          }),
        );
      }
      const live = /^\/api\/runs\/([^/]+)\/live$/.exec(url.pathname);
      if (live) {
        const liveCursors = runCursors(request, url);
        return liveRun(
          request,
          response,
          query,
          required(url, "sessionId"),
          live[1]!,
          liveCursors.replay,
          liveCursors.spans,
        );
      }
      return json(response, 404, { error: "Not found" });
    } catch (error) {
      return json(response, 400, { error: publicError(error) });
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Preview server did not bind");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const socket of sockets) socket.destroy();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function secure(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  );
}

function validHost(host: string | undefined): boolean {
  return /^127\.0\.0\.1:\d+$/.test(host ?? "") || /^localhost:\d+$/.test(host ?? "");
}

function required(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (!value) throw new Error(`Invalid ${name}`);
  assertTraceId(value, name);
  return value;
}

function cursor(request: IncomingMessage, url: URL): number {
  const lastEventId = request.headers["last-event-id"];
  if (typeof lastEventId === "string" && lastEventId.length > 0) {
    const value = Number(lastEventId);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid Last-Event-ID");
    return value;
  }
  return number(url, "cursor", 0);
}

function discoveryCursor(request: IncomingMessage, url: URL): number | "latest" {
  return request.headers["last-event-id"] || url.searchParams.has("cursor")
    ? cursor(request, url)
    : "latest";
}

function runCursors(request: IncomingMessage, url: URL): { replay: number; spans: number } {
  const lastEventId = request.headers["last-event-id"];
  if (typeof lastEventId === "string" && lastEventId.length > 0) {
    const match = /^(\d+):(\d+)$/.exec(lastEventId);
    if (!match) throw new Error("Invalid Last-Event-ID");
    const replay = Number(match[1]);
    const spans = Number(match[2]);
    if (!Number.isSafeInteger(replay) || !Number.isSafeInteger(spans)) {
      throw new Error("Invalid Last-Event-ID");
    }
    return { replay, spans };
  }
  return {
    replay: number(url, "cursor", 0),
    spans: number(url, "spanCursor", 0),
  };
}

function limit(url: URL): number {
  return Math.min(1_000, number(url, "limit", 500, 1));
}

function number(url: URL, name: string, fallback: number, minimum = 0): number {
  const raw = url.searchParams.get(name);
  const value = raw === null ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`Invalid ${name}`);
  return value;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  if (response.writableEnded) return;
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(response.req.method === "HEAD" ? undefined : JSON.stringify(value));
}

async function asset(response: ServerResponse, name: string, contentType: string): Promise<void> {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const path = await firstReadable([
    join(moduleDirectory, "assets", name),
    join(moduleDirectory, "..", "assets", name),
  ]);
  response.writeHead(200, { "Content-Type": contentType });
  response.end(response.req.method === "HEAD" ? undefined : await readFile(path));
}

async function firstReadable(paths: readonly string[]): Promise<string> {
  for (const path of paths) {
    try {
      await access(path);
      return path;
    } catch {
      continue;
    }
  }
  throw new Error("Trace preview assets are unavailable");
}

async function streamPayload(
  request: IncomingMessage,
  response: ServerResponse,
  parts: AsyncIterable<Buffer>,
): Promise<void> {
  response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  for await (const part of parts) {
    if (!response.write(part)) {
      await new Promise<void>((resolve) => response.once("drain", resolve));
    }
  }
  response.end();
}

function prepareSse(request: IncomingMessage, response: ServerResponse): boolean {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    Connection: "keep-alive",
    "Cache-Control": "no-store",
  });
  if (request.method === "HEAD") {
    response.end();
    return false;
  }
  response.write(": connected\n\n");
  return true;
}

function liveActivity(
  request: IncomingMessage,
  response: ServerResponse,
  query: TraceQueryPort,
  initialCursor: number | "latest",
): void {
  if (!prepareSse(request, response)) return;
  follow(request, response, async () => {
    if (initialCursor === "latest") {
      initialCursor = await query.activityEndCursor();
      return;
    }
    const page = await query.activityChunk(initialCursor, 1_000);
    for (const entry of page.entries) {
      await writeSse(response, entry.cursor, undefined, entry.value);
    }
    initialCursor = page.cursor;
  });
}

function liveRun(
  request: IncomingMessage,
  response: ServerResponse,
  query: TraceQueryPort,
  sessionId: string,
  runId: string,
  initialReplayCursor: number,
  initialSpanCursor: number,
): void {
  if (!prepareSse(request, response)) return;
  follow(request, response, async () => {
    const replay = await query.replayChunk(sessionId, runId, initialReplayCursor, 1_000);
    for (const entry of replay.entries) {
      initialReplayCursor = entry.cursor;
      await writeSse(
        response,
        `${initialReplayCursor}:${initialSpanCursor}`,
        "replay",
        entry.value,
      );
    }
    initialReplayCursor = replay.cursor;
    const spans = await query.spanRecords(sessionId, runId, initialSpanCursor, 1_000);
    for (const entry of spans.entries) {
      initialSpanCursor = entry.cursor;
      await writeSse(response, `${initialReplayCursor}:${initialSpanCursor}`, "span", entry.value, {
        spanCursor: entry.cursor,
      });
    }
    initialSpanCursor = spans.cursor;
  });
}

function follow(
  request: IncomingMessage,
  response: ServerResponse,
  poll: () => Promise<void>,
): void {
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  const close = () => {
    closed = true;
    if (timer) clearTimeout(timer);
  };
  request.on("close", close);
  response.on("close", close);
  const run = async () => {
    if (closed || response.writableEnded) return;
    try {
      await poll();
    } catch (error) {
      await writeSse(response, undefined, "error", {
        message: publicError(error),
      });
    }
    if (!closed && !response.writableEnded) timer = setTimeout(run, POLL_MS);
  };
  void run();
}

async function writeSse(
  response: ServerResponse,
  id: string | number | undefined,
  event: string | undefined,
  data: unknown,
  metadata: Record<string, number> = {},
): Promise<void> {
  const payload = JSON.stringify(
    Object.keys(metadata).length > 0 ? { ...metadata, record: data } : data,
  );
  const frame = `${id === undefined ? "" : `id: ${id}\n`}${event ? `event: ${event}\n` : ""}data: ${payload}\n\n`;
  if (!response.write(frame)) await new Promise<void>((resolve) => response.once("drain", resolve));
}

function publicError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /^(Invalid|Trace (?:run|session)|Method not allowed|Not found)/.test(message)
    ? message
    : "Trace data is unavailable";
}
