import { createConnection, createServer, type Server, type Socket } from "node:net";
import { chmod } from "node:fs/promises";
import { once } from "node:events";
import { isDeepStrictEqual } from "node:util";
import {
  ToolInputValidator,
  throwIfAborted,
  type ModelCacheCapability,
  type ModelRequest,
  type RuntimeModelSelection,
} from "@omni-agent/core";
import type {
  ModelTransportRuntimePort,
  ModelTransportExecutionOptions,
  ModelTransportEvent,
} from "../cache/contracts";
import type { ModelSelection } from "../vendors/types";
import { ModelChannelFrames } from "./framing";

export interface ModelExecutionDescriptor {
  readonly selection: RuntimeModelSelection;
  readonly configuration: ModelSelection;
  readonly cacheCapability: ModelCacheCapability;
  readonly credentialType: "api_key" | "oauth";
}
export interface ModelExecutionBinding {
  readonly selection: RuntimeModelSelection;
  readonly configuration: ModelSelection;
  readonly cacheCapability: ModelCacheCapability;
  readonly credentialType: "api_key" | "oauth";
  readonly transport: ModelTransportRuntimePort;
}

type WireOptions = Omit<ModelTransportExecutionOptions, "signal" | "credential">;
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
const validator = new ToolInputValidator();
const requestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["type", "request", "options"],
  properties: {
    type: { const: "request" },
    request: {
      type: "object",
      additionalProperties: false,
      required: ["systemPrompt", "messages"],
      properties: {
        systemPrompt: { type: "string" },
        messages: { type: "array", items: { type: "object" } },
        tools: { type: "array", items: { type: "object" } },
      },
    },
    options: {
      type: "object",
      additionalProperties: false,
      required: ["maxOutputTokens", "providerCache"],
      properties: {
        timeoutMs: { type: "integer", minimum: 1 },
        maxRetries: { type: "integer", minimum: 0 },
        maxOutputTokens: { type: "integer", minimum: 1 },
        providerCache: {
          type: "object",
          additionalProperties: false,
          required: ["cacheRetention"],
          properties: {
            sessionId: { type: "string" },
            cacheRetention: { enum: ["none", "short", "long"] },
          },
        },
      },
    },
  },
};
function requestFrame(value: unknown): { request: ModelRequest; options: WireOptions } {
  if (!record(value) || validator.validate(requestSchema, value))
    throw new Error("Invalid model execution request");
  return value as unknown as { request: ModelRequest; options: WireOptions };
}

/** A per-run, single-admission capability. No listener remains when ready is sent. */
export async function listenModelExecution(
  path: string,
  binding: ModelExecutionBinding,
): Promise<{ closed: Promise<void>; close(): void }> {
  let admitted = false;
  let peer: Socket | undefined;
  let resolveClosed!: () => void;
  let rejectClosed!: (error: unknown) => void;
  const closed = new Promise<void>((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });
  // A caller may await startup before awaiting completion.
  void closed.catch(() => {});
  const abort = new AbortController();
  const server: Server = createServer((socket) => {
    if (admitted) {
      socket.destroy();
      return;
    }
    admitted = true;
    peer = socket;
    // net.Server.close stops admission and unlinks the Unix socket synchronously.
    // Waiting for its callback here would deadlock on this admitted connection.
    server.close();
    socket.once("close", () => abort.abort(new Error("Model execution client disconnected")));
    socket.once("end", () => abort.abort(new Error("Model execution client disconnected")));
    void serve(socket)
      .then(resolveClosed, rejectClosed)
      .finally(() => socket.destroy());
  });
  server.on("error", rejectClosed);
  try {
    server.listen(path);
    await once(server, "listening");
    await chmod(path, 0o600);
  } catch (error) {
    abort.abort();
    peer?.destroy();
    if (server.listening) server.close();
    throw error;
  }
  return {
    closed,
    close() {
      abort.abort();
      peer?.destroy();
      if (server.listening) server.close();
      if (!peer) resolveClosed();
    },
  };

  async function serve(socket: Socket): Promise<void> {
    const frames = new ModelChannelFrames(socket);
    const { requestHeaders: _privateHeaders, ...selection } = binding.selection;
    await frames.write({
      type: "ready",
      version: 1,
      descriptor: {
        selection,
        configuration: binding.configuration,
        cacheCapability: binding.cacheCapability,
        credentialType: binding.credentialType,
      },
    });
    let phase = "request";
    try {
      while (!abort.signal.aborted) {
        phase = "request";
        const { request, options } = requestFrame(await frames.read());
        // ModelRuntime remains the owner of provider/model output-budget validation.
        phase = "provider";
        for await (const event of binding.transport.stream(binding.selection, request, {
          ...options,
          signal: abort.signal,
        })) {
          await frames.write({ type: "event", event });
        }
        phase = "completion";
        await frames.write({ type: "end" });
      }
    } catch (error) {
      if (!abort.signal.aborted) {
        // Only a fixed phase crosses the boundary, never provider exceptions or payloads.
        await frames.write({ type: "failure", phase }).catch(() => {});
        throw error;
      }
    }
  }
}

/** Cache policy stays in the caller; this replaces only the provider transport. */
export class ModelExecutionClient implements ModelTransportRuntimePort {
  private active = false;
  private constructor(
    private readonly frames: ModelChannelFrames,
    readonly descriptor: ModelExecutionDescriptor,
  ) {}
  static async connect(path: string, signal?: AbortSignal): Promise<ModelExecutionClient> {
    throwIfAborted(signal);
    const socket = createConnection({ path, signal });
    const frames = new ModelChannelFrames(socket);
    try {
      const ready = await frames.read();
      if (
        !record(ready) ||
        ready.type !== "ready" ||
        ready.version !== 1 ||
        !record(ready.descriptor) ||
        !record(ready.descriptor.selection) ||
        !record(ready.descriptor.configuration) ||
        !record(ready.descriptor.cacheCapability)
      )
        throw new Error("Invalid model execution handshake");
      return new ModelExecutionClient(
        frames,
        ready.descriptor as unknown as ModelExecutionDescriptor,
      );
    } catch (error) {
      socket.destroy();
      throw error;
    }
  }
  close(): void {
    this.frames.socket.destroy();
  }
  private async receive(): Promise<Record<string, unknown>> {
    const frame = await this.frames.read();
    if (!record(frame)) throw new Error("Invalid model execution response");
    if (frame.type === "failure") {
      const phase = ["request", "provider", "completion"].includes(String(frame.phase))
        ? String(frame.phase)
        : "unknown";
      throw new Error(`Model execution service failed during ${phase}`);
    }
    return frame;
  }
  async *stream(
    selection: RuntimeModelSelection,
    request: ModelRequest,
    options: ModelTransportExecutionOptions,
  ): AsyncIterable<ModelTransportEvent> {
    if (this.active) throw new Error("Model execution session already has an active request");
    if (!isDeepStrictEqual(selection, this.descriptor.selection))
      throw new Error("Model selection differs from the bound execution session");
    if (options.credential) throw new Error("Credentials belong to the model execution server");
    throwIfAborted(options.signal);
    this.active = true;
    let completed = false;
    const cancel = () => this.close();
    options.signal?.addEventListener("abort", cancel, { once: true });
    try {
      const { signal: _signal, credential: _credential, ...wireOptions } = options;
      // Prepared contexts structurally extend ModelRequest with local manifests.
      // Serialize the port contract, not runtime-only fields from its caller.
      const wireRequest: ModelRequest = {
        systemPrompt: request.systemPrompt,
        messages: request.messages,
        tools: request.tools,
      };
      await this.frames.write({ type: "request", request: wireRequest, options: wireOptions });
      while (true) {
        const frame = await this.receive();
        if (frame.type === "end") {
          completed = true;
          return;
        }
        if (frame.type !== "event" || !record(frame.event))
          throw new Error("Invalid model execution event");
        const event = frame.event as unknown as ModelTransportEvent;
        if (event.type === "done" || event.type === "error") {
          // CacheAwareModelRuntime intentionally stops at the terminal event.
          // Drain the transport boundary before exposing it to that consumer.
          const end = await this.receive();
          if (end.type !== "end") throw new Error("Invalid model execution completion");
          completed = true;
          yield event;
          return;
        }
        yield event;
      }
    } finally {
      options.signal?.removeEventListener("abort", cancel);
      this.active = false;
      // A partially consumed stream must never contaminate a subsequent request.
      if (!completed) this.close();
    }
  }
}
