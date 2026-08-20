import { request } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { TraceQueryPort } from "@omni-agent/app";
import { createPreviewServer, type PreviewServer } from "./trace-preview-server";

const servers: PreviewServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("Trace preview server", () => {
  it("binds to loopback and exposes read-only secured query APIs", async () => {
    const server = await createPreviewServer(queryFixture(), {
      assetsDirectory: join(dirname(fileURLToPath(import.meta.url)), ".."),
    });
    servers.push(server);
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);

    const sessions = await fetch(`${server.url}api/sessions`);
    expect(sessions.status).toBe(200);
    expect(sessions.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(await sessions.json()).toMatchObject([{ sessionId: "session", runs: 1 }]);

    const replay = await fetch(`${server.url}api/runs/run/replay?sessionId=session`);
    expect(await replay.json()).toMatchObject({
      cursor: expect.any(Number),
      entries: [{ value: { kind: "user.input", payload: "hello" } }],
    });
    const agent = await fetch(`${server.url}api/agent`);
    expect(await agent.json()).toEqual({ agentId: "coding", diskUsage: expect.any(Number) });

    const invalidHost = await new Promise<number | undefined>((resolve, reject) => {
      const outgoing = request(`${server.url}api/sessions`, { headers: { Host: "example.test" } });
      outgoing.on("response", (response) => {
        response.resume();
        resolve(response.statusCode);
      });
      outgoing.on("error", reject);
      outgoing.end();
    });
    expect(invalidHost).toBe(400);

    const invalidCursor = await fetch(`${server.url}api/runs/run/live?sessionId=session`, {
      headers: { "Last-Event-ID": "invalid" },
    });
    expect(invalidCursor.status).toBe(400);
    const write = await fetch(`${server.url}api/sessions`, { method: "POST" });
    expect(write.status).toBe(405);
  });
});

function queryFixture(): TraceQueryPort {
  return {
    agent: () => ({ agentId: "coding" }),
    diskUsage: async () => 128,
    sessions: async () => [
      { sessionId: "session", runs: 1, latestStartedAt: 1, status: "completed" },
    ],
    runs: async () => [],
    run: async () => ({
      version: 1,
      agentId: "coding",
      sessionId: "session",
      runId: "run",
      traceId: "trace",
      workspaceId: "workspace",
      cwd: "/workspace",
      startedAt: 1,
      completedAt: 2,
      status: "completed",
    }),
    spanSnapshot: async () => ({ spans: [], cursor: 0 }),
    replayChunk: async () => ({
      cursor: 1,
      entries: [
        {
          cursor: 1,
          value: {
            version: 1,
            agentId: "coding",
            sessionId: "session",
            runId: "run",
            seq: 1,
            timestamp: 1,
            kind: "user.input",
            correlation: { traceId: "trace" },
            payload: "hello",
          },
        },
      ],
    }),
    spanRecords: async () => ({ entries: [], cursor: 0 }),
    activityChunk: async () => ({ entries: [], cursor: 0 }),
    activityEndCursor: async () => 0,
    async *payloadParts() {},
  };
}
