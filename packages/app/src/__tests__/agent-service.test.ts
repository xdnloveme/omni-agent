import { describe, expect, it, vi } from "vitest";
import {
  AgentSessionNotFoundError,
  InteractionError,
  type StreamCallbacks,
} from "@omni-agent/core";
import type { LoadedAgentPackage } from "../assembly/contracts";
import { AgentModelNotConfiguredError } from "../assembly/errors";
import {
  AgentPackageCatalogError,
  type AgentPackageCatalogPort,
} from "../agent-packages/contracts";
import type { AgentInstance } from "../application/agent-factory";
import { AgentService } from "../application/agent-service/agent-service";
import { toAgentServiceFailure } from "../application/agent-service/agent-service-failure";
import type { AgentServiceEvent } from "../application/agent-service/contracts";

describe("AgentService", () => {
  it("lists available Agents and creates a new owned Session", async () => {
    const instance = fakeInstance("restored");
    const { service } = createFixture(async () => instance);

    await expect(service.listAgents()).resolves.toEqual([
      expect.objectContaining({ id: "coding", displayName: "Coding" }),
    ]);
    await expect(service.createSession({ agentId: "coding" })).resolves.toEqual({
      agentId: "coding",
      sessionId: "restored-new",
    });
    await service.closeSession({ agentId: "coding", sessionId: "restored-new" });
    expect(instance.dispose).toHaveBeenCalledOnce();
    await service.dispose();
  });

  it("uses Catalog.list as its allowlist and deduplicates concurrent opens", async () => {
    const opening = deferred<void>();
    const fixture = createFixture(async (sessionId) => {
      await opening.promise;
      return fakeInstance(sessionId);
    });
    const service = fixture.service;

    const first = service.openSession({ agentId: "coding", sessionId: "session-1" });
    const second = service.openSession({ agentId: "coding", sessionId: "session-1" });
    await vi.waitFor(() => expect(fixture.create).toHaveBeenCalledOnce());
    await expect(
      collect(service.run(request("opening", "session-1", "not-yet"))),
    ).resolves.toContainEqual(expect.objectContaining({ type: "failed", code: "session_opening" }));
    opening.resolve(undefined);
    await expect(Promise.all([first, second])).resolves.toEqual([
      { agentId: "coding", sessionId: "session-1" },
      { agentId: "coding", sessionId: "session-1" },
    ]);
    expect(fixture.create).toHaveBeenCalledOnce();

    await expect(
      service.openSession({ agentId: "external", sessionId: "session-2" }),
    ).rejects.toMatchObject({ code: "agent_not_available" });
    expect(fixture.catalog.load).not.toHaveBeenCalledWith("external");
    await service.dispose();
  });

  it("runs one Session in FIFO order and keeps the queue usable after failure", async () => {
    const releaseFirst = deferred<void>();
    const calls: string[] = [];
    const instance = fakeInstance("session-1", async (input, callbacks) => {
      calls.push(input);
      if (input === "first") await releaseFirst.promise;
      if (input === "fail") {
        callbacks.onError?.({ code: "agent_broken", message: "broken", retryable: false });
        return;
      }
      callbacks.onTextChunk?.({
        type: "text_delta",
        modelCallId: input,
        textSegmentId: "text",
        delta: input,
      });
      callbacks.onFinalResponse?.({ type: "final_response", modelCallId: input });
      callbacks.onDone?.();
    });
    const { service } = createFixture(async () => instance);
    await service.openSession({ agentId: "coding", sessionId: "session-1" });

    const first = collect(service.run(request("r1", "session-1", "first")));
    const failed = collect(service.run(request("r2", "session-1", "fail")));
    const third = collect(service.run(request("r3", "session-1", "third")));
    await vi.waitFor(() => expect(calls).toEqual(["first"]));
    await expect(
      collect(service.run(request("r1", "session-1", "duplicate"))),
    ).resolves.toContainEqual(
      expect.objectContaining({ type: "failed", code: "duplicate_request" }),
    );
    releaseFirst.resolve(undefined);

    expect((await first).map(({ type }) => type)).toEqual([
      "started",
      "text_delta",
      "final_response",
      "completed",
    ]);
    expect(await failed).toContainEqual(
      expect.objectContaining({ type: "failed", code: "agent_broken" }),
    );
    expect(await third).toContainEqual({ type: "completed" });
    expect(calls).toEqual(["first", "fail", "third"]);
    await service.dispose();
  });

  it("does not expose arbitrary internal errors through the Service event protocol", async () => {
    const instance = fakeInstance("session-1", async () => {
      throw Object.assign(new Error("Failed to read /private/internal/session.jsonl"), {
        code: "repository_io_failed",
      });
    });
    const { service } = createFixture(async () => instance);
    await service.openSession({ agentId: "coding", sessionId: "session-1" });

    await expect(collect(service.run(request("r1", "session-1", "fail")))).resolves.toContainEqual({
      type: "failed",
      code: "agent_service_operation_failed",
      message: "Agent service operation failed",
      retryable: false,
    });
    await service.dispose();
  });

  it("projects rich Catalog errors to a stable Failure without exposing local paths", () => {
    const failure = toAgentServiceFailure(
      new AgentPackageCatalogError(
        "agent_manifest_invalid",
        "Invalid Manifest at /private/internal/agent.yaml",
        "coding",
        "@omni-agent/agent-coding",
        "/private/internal/agent.yaml",
      ),
    );

    expect(failure).toEqual({
      code: "agent_manifest_invalid",
      message: "Agent definition is invalid",
      retryable: false,
    });
    expect(JSON.stringify(failure)).not.toContain("/private/internal");
  });

  it("projects missing model configuration as an actionable safe Failure", () => {
    expect(toAgentServiceFailure(new AgentModelNotConfiguredError("coding"))).toEqual({
      code: "agent_model_not_configured",
      message: "Model is not configured for this Agent",
      retryable: false,
    });
  });

  it("projects an unavailable Host interaction without exposing its request", () => {
    expect(
      toAgentServiceFailure(
        new InteractionError("interaction_unavailable", "Prompt at /private/project"),
      ),
    ).toEqual({
      code: "interaction_unavailable",
      message: "The current Host does not support this interaction",
      retryable: false,
    });
  });

  it("allows different Sessions to run concurrently", async () => {
    const entered = new Set<string>();
    const release = deferred<void>();
    const { service } = createFixture(async (sessionId) =>
      fakeInstance(sessionId, async (input, callbacks) => {
        entered.add(input);
        await release.promise;
        callbacks.onDone?.();
      }),
    );
    await Promise.all([
      service.openSession({ agentId: "coding", sessionId: "session-1" }),
      service.openSession({ agentId: "coding", sessionId: "session-2" }),
    ]);

    const first = collect(service.run(request("r1", "session-1", "one")));
    const second = collect(service.run(request("r2", "session-2", "two")));
    await vi.waitFor(() => expect(entered).toEqual(new Set(["one", "two"])));
    release.resolve(undefined);
    await expect(Promise.all([first, second])).resolves.toEqual([
      [{ type: "started", requestId: "r1", sessionId: "session-1" }, { type: "completed" }],
      [{ type: "started", requestId: "r2", sessionId: "session-2" }, { type: "completed" }],
    ]);
    await service.dispose();
  });

  it("continues disposing other Sessions and reports every cleanup failure", async () => {
    const instances: AgentInstance[] = [];
    const { service } = createFixture(async (sessionId) => {
      const instance = fakeInstance(sessionId);
      instances.push(instance);
      return instance;
    });
    await Promise.all([
      service.openSession({ agentId: "coding", sessionId: "session-1" }),
      service.openSession({ agentId: "coding", sessionId: "session-2" }),
    ]);
    vi.mocked(instances[0]!.dispose).mockRejectedValueOnce(new Error("cleanup failed"));

    await expect(service.dispose()).rejects.toMatchObject({
      code: "agent_service_disposal_failed",
      failures: [expect.objectContaining({ resource: expect.stringContaining("session-") })],
    });
    expect(instances[0]!.dispose).toHaveBeenCalledOnce();
    expect(instances[1]!.dispose).toHaveBeenCalledOnce();
    await expect(service.dispose()).resolves.toBeUndefined();
  });

  it("closes an opening Session deterministically without exposing a usable instance", async () => {
    const releaseFactory = deferred<void>();
    const instance = fakeInstance("session-1");
    const { service } = createFixture(async () => {
      await releaseFactory.promise;
      return instance;
    });
    const opening = service.openSession({ agentId: "coding", sessionId: "session-1" });
    const closing = service.closeSession({ agentId: "coding", sessionId: "session-1" });
    releaseFactory.resolve(undefined);

    await expect(opening).rejects.toMatchObject({ code: "session_closing" });
    await expect(closing).resolves.toBeUndefined();
    expect(instance.dispose).toHaveBeenCalledOnce();
    await expect(
      collect(service.run(request("after-close", "session-1", "no"))),
    ).resolves.toContainEqual(
      expect.objectContaining({ type: "failed", code: "session_not_open" }),
    );
    await service.dispose();
  });

  it("deduplicates latest and explicit opens after they resolve to the same Session", async () => {
    const bothFactoriesEntered = deferred<void>();
    const instances: AgentInstance[] = [];
    const { service, create } = createFixture(async () => {
      const instance = fakeInstance("shared-session");
      instances.push(instance);
      if (instances.length === 2) bothFactoriesEntered.resolve(undefined);
      await bothFactoriesEntered.promise;
      return instance;
    });

    await expect(
      Promise.all([
        service.openSession({ agentId: "coding" }),
        service.openSession({ agentId: "coding", sessionId: "shared-session" }),
      ]),
    ).resolves.toEqual([
      { agentId: "coding", sessionId: "shared-session" },
      { agentId: "coding", sessionId: "shared-session" },
    ]);
    expect(create).toHaveBeenCalledTimes(2);
    expect(
      instances.reduce(
        (count, instance) => count + vi.mocked(instance.dispose).mock.calls.length,
        0,
      ),
    ).toBe(1);

    await service.dispose();
    expect(
      instances.reduce(
        (count, instance) => count + vi.mocked(instance.dispose).mock.calls.length,
        0,
      ),
    ).toBe(2);
  });

  it("disposes an opening Session without leaving an instance reachable", async () => {
    const releaseFactory = deferred<void>();
    const instance = fakeInstance("session-1");
    const { service, create } = createFixture(async () => {
      await releaseFactory.promise;
      return instance;
    });
    const opening = service.openSession({ agentId: "coding", sessionId: "session-1" });
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    const disposing = service.dispose();
    releaseFactory.resolve(undefined);

    await expect(opening).rejects.toMatchObject({ code: "session_closing" });
    await expect(disposing).resolves.toBeUndefined();
    expect(instance.dispose).toHaveBeenCalledOnce();
    await expect(service.dispose()).resolves.toBeUndefined();
  });

  it("rolls back a failed Session activation and can retry cleanly", async () => {
    const failed = fakeInstance("session-1");
    vi.mocked(failed.application.openSession).mockRejectedValueOnce(
      new AgentSessionNotFoundError("session-1"),
    );
    const recovered = fakeInstance("session-1");
    let attempt = 0;
    const { service } = createFixture(async () => (++attempt === 1 ? failed : recovered));

    await expect(
      service.openSession({ agentId: "coding", sessionId: "session-1" }),
    ).rejects.toMatchObject({
      code: "session_not_found",
      cause: expect.objectContaining({
        code: "agent_session_not_found",
        sessionId: "session-1",
      }),
    });
    expect(failed.dispose).toHaveBeenCalledOnce();
    await expect(
      service.openSession({ agentId: "coding", sessionId: "session-1" }),
    ).resolves.toEqual({ agentId: "coding", sessionId: "session-1" });
    await service.dispose();
    expect(recovered.dispose).toHaveBeenCalledOnce();
  });

  it("retains both opening and cleanup failures with their owned resource", async () => {
    const instance = fakeInstance("session-1");
    vi.mocked(instance.application.openSession).mockRejectedValueOnce(
      new Error("Session activation failed"),
    );
    vi.mocked(instance.dispose).mockRejectedValueOnce(new Error("Instance cleanup failed"));
    const { service } = createFixture(async () => instance);

    await expect(
      service.openSession({ agentId: "coding", sessionId: "session-1" }),
    ).rejects.toMatchObject({
      code: "agent_service_disposal_failed",
      failures: [
        {
          resource: "opening:coding:session-1",
          error: expect.objectContaining({
            errors: [
              expect.objectContaining({ message: "Session activation failed" }),
              expect.objectContaining({ message: "Instance cleanup failed" }),
            ],
          }),
        },
      ],
    });
    expect(instance.dispose).toHaveBeenCalledOnce();
    await service.dispose();
  });

  it("does not start a queued request after its consumer exits", async () => {
    const releaseFirst = deferred<void>();
    const calls: string[] = [];
    const instance = fakeInstance("session-1", async (input, callbacks) => {
      calls.push(input);
      if (input === "first") await releaseFirst.promise;
      callbacks.onDone?.();
    });
    const { service } = createFixture(async () => instance);
    await service.openSession({ agentId: "coding", sessionId: "session-1" });
    const first = collect(service.run(request("r1", "session-1", "first")));
    const queued = service.run(request("r2", "session-1", "queued"))[Symbol.asyncIterator]();
    const pendingRead = queued.next();
    await vi.waitFor(() => expect(calls).toEqual(["first"]));
    await queued.return?.();
    await expect(pendingRead).resolves.toEqual({ done: true, value: undefined });
    releaseFirst.resolve(undefined);
    await first;
    await vi.waitFor(() => expect(calls).toEqual(["first"]));
    await service.dispose();
  });

  it("cancels active work when the consumer stops and closes each instance once", async () => {
    let observedSignal: AbortSignal | undefined;
    const aborted = deferred<void>();
    const instance = fakeInstance("session-1", async (_input, _callbacks, signal) => {
      observedSignal = signal;
      await new Promise<void>((resolve) => {
        signal?.addEventListener(
          "abort",
          () => {
            aborted.resolve(undefined);
            resolve();
          },
          { once: true },
        );
      });
    });
    const { service } = createFixture(async () => instance);
    await service.openSession({ agentId: "coding", sessionId: "session-1" });
    const iterator = service.run(request("r1", "session-1", "wait"))[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: "started", requestId: "r1", sessionId: "session-1" },
    });
    await iterator.return?.();
    await aborted.promise;
    expect(observedSignal?.aborted).toBe(true);

    await Promise.all([
      service.closeSession({ agentId: "coding", sessionId: "session-1" }),
      service.closeSession({ agentId: "coding", sessionId: "session-1" }),
    ]);
    expect(instance.dispose).toHaveBeenCalledOnce();
    await service.dispose();
  });

  it("shares one close operation when Service disposal begins during Session closing", async () => {
    const runEntered = deferred<void>();
    const instance = fakeInstance("session-1", async (_input, _callbacks, signal) => {
      runEntered.resolve(undefined);
      await new Promise<void>((resolve) =>
        signal?.addEventListener("abort", () => resolve(), { once: true }),
      );
    });
    const { service } = createFixture(async () => instance);
    await service.openSession({ agentId: "coding", sessionId: "session-1" });
    const running = collect(service.run(request("r1", "session-1", "wait")));
    await runEntered.promise;

    const closing = service.closeSession({ agentId: "coding", sessionId: "session-1" });
    const disposing = service.dispose();

    await expect(Promise.all([closing, disposing, running])).resolves.toEqual([
      undefined,
      undefined,
      [{ type: "started", requestId: "r1", sessionId: "session-1" }, { type: "cancelled" }],
    ]);
    expect(instance.dispose).toHaveBeenCalledOnce();
  });

  it("ignores callbacks that arrive after the first terminal event", async () => {
    const instance = fakeInstance("session-1", async (_input, callbacks) => {
      callbacks.onDone?.();
      callbacks.onTextChunk?.({
        type: "text_delta",
        modelCallId: "late",
        textSegmentId: "late",
        delta: "late",
      });
      callbacks.onFinalResponse?.({ type: "final_response", modelCallId: "late" });
      callbacks.onError?.({ code: "late_failure", message: "late", retryable: false });
    });
    const { service } = createFixture(async () => instance);
    await service.openSession({ agentId: "coding", sessionId: "session-1" });

    await expect(collect(service.run(request("r1", "session-1", "done")))).resolves.toEqual([
      { type: "started", requestId: "r1", sessionId: "session-1" },
      { type: "completed" },
    ]);
    await service.dispose();
  });

  it("rejects a second consumer for the same event stream", async () => {
    const instance = fakeInstance("session-1");
    const { service } = createFixture(async () => instance);
    await service.openSession({ agentId: "coding", sessionId: "session-1" });
    const stream = service.run(request("r1", "session-1", "once"));
    const iterator = stream[Symbol.asyncIterator]();

    expect(() => stream[Symbol.asyncIterator]()).toThrow(
      expect.objectContaining({ code: "event_stream_already_consumed" }),
    );
    await iterator.return?.();
    await service.dispose();
  });
});

function createFixture(makeInstance: (sessionId: string) => Promise<AgentInstance>): {
  service: AgentService;
  catalog: AgentPackageCatalogPort;
  create: ReturnType<typeof vi.fn>;
} {
  const catalog: AgentPackageCatalogPort = {
    list: vi.fn(async () => [
      {
        id: "coding",
        displayName: "Coding",
        description: "Coding Agent",
        packageName: "@omni-agent/agent-coding",
        packageVersion: "1.0.0",
      },
    ]),
    load: vi.fn(async () => ({}) as LoadedAgentPackage),
  };
  let instanceNumber = 0;
  const create = vi.fn(async () => makeInstance(`session-${++instanceNumber}`));
  const service = new AgentService({
    catalog,
    factory: { create },
  });
  return { service, catalog, create };
}

function fakeInstance(
  initialSessionId: string,
  run: (input: string, callbacks: StreamCallbacks, signal?: AbortSignal) => Promise<void> = async (
    _input,
    callbacks,
  ) => callbacks.onDone?.(),
): AgentInstance {
  let sessionId = initialSessionId;
  const dispose = vi.fn(async () => undefined);
  return {
    id: "coding",
    application: {
      run,
      openSession: vi.fn(async (nextSessionId: string) => {
        sessionId = nextSessionId;
        return { sessionId };
      }),
      newSession: vi.fn(async () => {
        sessionId = `${initialSessionId}-new`;
        return sessionId;
      }),
      currentSessionSnapshot: vi.fn(() => ({ sessionId })),
    },
    dispose,
  } as unknown as AgentInstance;
}

function request(
  requestId: string,
  sessionId: string,
  text: string,
): {
  requestId: string;
  agentId: string;
  sessionId: string;
  input: { type: "text"; text: string };
} {
  return { requestId, agentId: "coding", sessionId, input: { type: "text", text } };
}

async function collect(events: AsyncIterable<AgentServiceEvent>): Promise<AgentServiceEvent[]> {
  const result: AgentServiceEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
