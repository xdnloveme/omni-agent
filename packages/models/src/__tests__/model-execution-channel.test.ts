import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { once } from "node:events";
import {
  listenModelExecution,
  ModelExecutionClient,
  type ModelExecutionBinding,
} from "../execution-channel/channel";
import { ModelChannelFrames } from "../execution-channel/framing";
import { CacheAwareModelRuntime } from "../cache/cacheAwareRuntime";
import { DefaultModelCachePolicy } from "../cache/policy";
import type { ModelTransportEvent } from "../cache/contracts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});
const selection = {
  vendorId: "v",
  connectionId: "c",
  providerId: "p",
  modelId: "m",
  contextWindow: 10000,
  modelMaxOutputTokens: 1000,
  requestedOutputTokens: 1000,
};
const options = { maxOutputTokens: 50, providerCache: { cacheRetention: "none" as const } };
const request = { systemPrompt: "system", messages: [] };
async function setup(transport: ModelExecutionBinding["transport"]) {
  const root = await mkdtemp(join(tmpdir(), "mc-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "s");
  const server = await listenModelExecution(path, {
    selection: { ...selection, requestHeaders: { authorization: "private" } },
    configuration: { vendorId: "v", connectionId: "c", modelId: "m" },
    credentialType: "api_key",
    cacheCapability: { mode: "none", retentions: ["none"], stableScopeRetentions: [] },
    transport,
  });
  cleanups.push(async () => {
    server.close();
    await server.closed.catch(() => {});
  });
  return { path, server };
}
async function collect(stream: AsyncIterable<ModelTransportEvent>) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("isolated model execution session", () => {
  it("removes admission before ready, retains provider-only headers, and streams repeated requests", async () => {
    let calls = 0;
    const { path, server } = await setup({
      async *stream(bound, received, execution) {
        calls++;
        expect(bound.requestHeaders).toEqual({ authorization: "private" });
        expect(received).toEqual(request);
        expect(execution.maxOutputTokens).toBe(50);
        yield { type: "text_delta", delta: "hello" };
      },
    });
    const client = await ModelExecutionClient.connect(path);
    expect(client.descriptor.selection).toEqual(selection);
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(ModelExecutionClient.connect(path)).rejects.toThrow();
    for (let i = 0; i < 2; i++)
      expect(
        await collect(
          client.stream(
            selection,
            { ...request, manifest: { local: true } } as typeof request,
            options,
          ),
        ),
      ).toEqual([{ type: "text_delta", delta: "hello" }]);
    expect(calls).toBe(2);
    client.close();
    await server.closed;
  });

  it("preserves the existing cache consumer's terminal short-circuit across calls", async () => {
    const message = {
      role: "assistant" as const,
      content: [],
      model: "m",
      provider: "p",
      api: "openai-completions",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop" as const,
      timestamp: 1,
    };
    const { path, server } = await setup({
      async *stream() {
        yield { type: "done", message };
      },
    });
    const client = await ModelExecutionClient.connect(path);
    const runtime = new CacheAwareModelRuntime(
      client,
      new DefaultModelCachePolicy(),
      () => client.descriptor.cacheCapability,
    );
    for (let i = 0; i < 2; i++) {
      const events = [];
      for await (const event of runtime.stream(selection, request, {
        maxOutputTokens: 50,
        cache: { retention: "none" },
        identity: {
          modelCallId: String(i),
          purpose: "primary",
          sessionId: "session",
          agentId: "agent",
        },
      }))
        events.push(event);
      expect(events.map((event) => event.type)).toEqual(["cache_report", "done"]);
    }
    client.close();
    await server.closed;
  });

  it("propagates cancellation to the provider and never reuses a partial stream", async () => {
    let providerAborted!: () => void;
    const aborted = new Promise<void>((resolve) => {
      providerAborted = resolve;
    });
    const { path, server } = await setup({
      async *stream(_selection, _request, execution) {
        yield { type: "text_delta", delta: "first" };
        await new Promise<void>((resolve) =>
          execution.signal!.addEventListener(
            "abort",
            () => {
              providerAborted();
              resolve();
            },
            { once: true },
          ),
        );
      },
    });
    const client = await ModelExecutionClient.connect(path);
    const controller = new AbortController();
    const iterator = client
      .stream(selection, request, { ...options, signal: controller.signal })
      [Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ type: "text_delta", delta: "first" });
    const waiting = iterator.next();
    controller.abort();
    await expect(waiting).rejects.toThrow();
    await aborted;
    await server.closed;
    await expect(collect(client.stream(selection, request, options))).rejects.toThrow();
  });

  it("fails closed on provider failure rather than accepting EOF as completion", async () => {
    const { path, server } = await setup({
      async *stream() {
        yield { type: "text_delta", delta: "partial" };
        throw new Error("provider failed");
      },
    });
    const client = await ModelExecutionClient.connect(path);
    await expect(collect(client.stream(selection, request, options))).rejects.toThrow();
    await expect(server.closed).rejects.toThrow("provider failed");
  });

  it("rejects injected credentials and arbitrary transport options before provider invocation", async () => {
    let called = false;
    const { path, server } = await setup({
      async *stream() {
        called = true;
        yield { type: "text_delta", delta: "unexpected" };
      },
    });
    const socket = createConnection(path);
    await once(socket, "connect");
    const frames = new ModelChannelFrames(socket);
    await frames.read();
    await frames.write({
      type: "request",
      request,
      options: { ...options, credential: { type: "api_key", key: "injected" } },
    });
    await expect(server.closed).rejects.toThrow("Invalid model execution request");
    expect(called).toBe(false);
    socket.destroy();
  });
});
