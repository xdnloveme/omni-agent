import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import type { TraceQueryPort } from "@omni-agent/app";
import { assertTraceId } from "@omni-agent/core";
import { Hono } from "hono";
import { stream, streamSSE, type SSEStreamingApi } from "hono/streaming";

const POLL_MS = 300;

export interface PreviewServer {
  readonly url: string;
  close(): Promise<void>;
}

export async function createPreviewServer(
  query: TraceQueryPort,
  options: { readonly assetsDirectory?: string } = {},
): Promise<PreviewServer> {
  const assetsDirectory = options.assetsDirectory ?? (await resolveAssetsDirectory());
  const app = createTracePreviewApp(query, assetsDirectory);
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  const sockets = new Set<import("node:net").Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  if (!server.listening) {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
  }
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

export function createTracePreviewApp(query: TraceQueryPort, assetsDirectory: string): Hono {
  const app = new Hono();

  app.use("*", async (context, next) => {
    secure(context.header.bind(context));
    if (!validHost(context.req.header("host"))) {
      return context.json({ error: "Invalid Host" }, 400);
    }
    if (context.req.method !== "GET" && context.req.method !== "HEAD") {
      return context.json({ error: "Method not allowed" }, 405);
    }
    await next();
  });

  app.get("/api/agent", async (context) =>
    context.json({ ...query.agent(), diskUsage: await query.diskUsage() }),
  );
  app.get("/api/sessions", async (context) => context.json(await query.sessions()));
  app.get("/api/sessions/:sessionId/runs", async (context) =>
    context.json(await query.runs(traceId(context.req.param("sessionId"), "sessionId"))),
  );
  app.get("/api/runs/:runId", async (context) =>
    context.json(
      await query.run(
        required(context.req.url, "sessionId"),
        traceId(context.req.param("runId"), "runId"),
      ),
    ),
  );
  app.get("/api/runs/:runId/spans", async (context) =>
    context.json(
      await query.spanSnapshot(
        required(context.req.url, "sessionId"),
        traceId(context.req.param("runId"), "runId"),
      ),
    ),
  );
  app.get("/api/runs/:runId/replay", async (context) => {
    const url = new URL(context.req.url);
    return context.json(
      await query.replayChunk(
        required(url, "sessionId"),
        traceId(context.req.param("runId"), "runId"),
        cursor(context.req.header("last-event-id"), url),
        limit(url),
      ),
    );
  });
  app.get("/api/runs/:runId/payloads/:payloadId", async (context) => {
    const url = new URL(context.req.url);
    const parts = Number(url.searchParams.get("parts"));
    if (!Number.isInteger(parts) || parts < 1 || parts > 100_000) {
      throw new Error("Invalid payload parts");
    }
    const payloadParts = query.payloadParts(
      required(url, "sessionId"),
      traceId(context.req.param("runId"), "runId"),
      {
        payloadId: traceId(context.req.param("payloadId"), "payloadId"),
        parts,
        encoding: "utf8-json",
      },
    );
    return stream(context, async (output) => {
      for await (const part of payloadParts) await output.write(part);
    });
  });
  app.get("/api/live", (context) => {
    const url = new URL(context.req.url);
    let current = discoveryCursor(context.req.header("last-event-id"), url);
    return streamSSE(context, async (output) => {
      await follow(output, async () => {
        if (current === "latest") {
          current = await query.activityEndCursor();
          return;
        }
        const page = await query.activityChunk(current, 1_000);
        for (const entry of page.entries)
          await writeSse(output, entry.cursor, undefined, entry.value);
        current = page.cursor;
      });
    });
  });
  app.get("/api/runs/:runId/live", (context) => {
    const url = new URL(context.req.url);
    const sessionId = required(url, "sessionId");
    const runId = traceId(context.req.param("runId"), "runId");
    const cursors = runCursors(context.req.header("last-event-id"), url);
    let replayCursor = cursors.replay;
    let spanCursor = cursors.spans;
    return streamSSE(context, async (output) => {
      await follow(output, async () => {
        const replay = await query.replayChunk(sessionId, runId, replayCursor, 1_000);
        for (const entry of replay.entries) {
          replayCursor = entry.cursor;
          await writeSse(output, `${replayCursor}:${spanCursor}`, "replay", entry.value);
        }
        replayCursor = replay.cursor;
        const spans = await query.spanRecords(sessionId, runId, spanCursor, 1_000);
        for (const entry of spans.entries) {
          spanCursor = entry.cursor;
          await writeSse(output, `${replayCursor}:${spanCursor}`, "span", entry.value, {
            spanCursor: entry.cursor,
          });
        }
        spanCursor = spans.cursor;
      });
    });
  });

  app.use("*", serveStatic({ root: assetsDirectory }));
  app.notFound((context) => context.json({ error: "Not found" }, 404));
  app.onError((error, context) => context.json({ error: publicError(error) }, 400));
  return app;
}

async function follow(output: SSEStreamingApi, poll: () => Promise<void>): Promise<void> {
  while (!output.aborted) {
    try {
      await poll();
    } catch (error) {
      await writeSse(output, undefined, "error", { message: publicError(error) });
    }
    if (!output.aborted) await output.sleep(POLL_MS);
  }
}

async function writeSse(
  output: SSEStreamingApi,
  id: string | number | undefined,
  event: string | undefined,
  data: unknown,
  metadata: Record<string, number> = {},
): Promise<void> {
  await output.writeSSE({
    ...(id === undefined ? {} : { id: String(id) }),
    ...(event ? { event } : {}),
    data: JSON.stringify(Object.keys(metadata).length > 0 ? { ...metadata, record: data } : data),
  });
}

function secure(header: (name: string, value: string) => void): void {
  header("Cache-Control", "no-store");
  header("Referrer-Policy", "no-referrer");
  header("X-Content-Type-Options", "nosniff");
  header(
    "Content-Security-Policy",
    "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  );
}

function validHost(host: string | undefined): boolean {
  return /^127\.0\.0\.1:\d+$/.test(host ?? "") || /^localhost:\d+$/.test(host ?? "");
}

function required(input: URL | string, name: string): string {
  const url = typeof input === "string" ? new URL(input) : input;
  const value = url.searchParams.get(name);
  if (!value) throw new Error(`Invalid ${name}`);
  return traceId(value, name);
}

function traceId(value: string, name: string): string {
  assertTraceId(value, name);
  return value;
}

function cursor(lastEventId: string | undefined, url: URL): number {
  if (lastEventId) {
    const value = Number(lastEventId);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid Last-Event-ID");
    return value;
  }
  return number(url, "cursor", 0);
}

function discoveryCursor(lastEventId: string | undefined, url: URL): number | "latest" {
  return lastEventId || url.searchParams.has("cursor") ? cursor(lastEventId, url) : "latest";
}

function runCursors(
  lastEventId: string | undefined,
  url: URL,
): { readonly replay: number; readonly spans: number } {
  if (lastEventId) {
    const match = /^(\d+):(\d+)$/.exec(lastEventId);
    if (!match) throw new Error("Invalid Last-Event-ID");
    const replay = Number(match[1]);
    const spans = Number(match[2]);
    if (!Number.isSafeInteger(replay) || !Number.isSafeInteger(spans)) {
      throw new Error("Invalid Last-Event-ID");
    }
    return { replay, spans };
  }
  return { replay: number(url, "cursor", 0), spans: number(url, "spanCursor", 0) };
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

async function resolveAssetsDirectory(): Promise<string> {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(moduleDirectory, "..", "..", "..", "..", "dist", "browser", "trace"),
    join(moduleDirectory, "..", "assets"),
    join(moduleDirectory, "assets"),
  ];
  for (const candidate of candidates) {
    try {
      await access(join(candidate, "index.html"));
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error("Trace preview assets are unavailable");
}

function publicError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /^(Invalid|Trace (?:run|session)|Method not allowed|Not found)/.test(message)
    ? message
    : "Trace data is unavailable";
}
