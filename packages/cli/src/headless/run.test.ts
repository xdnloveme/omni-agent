import { describe, expect, it, vi } from "vitest";
import type { AgentServiceEvent, AgentServicePort } from "@omni-agent/app";
import { runHeadless } from "./run";

function fixture(events: AgentServiceEvent[]) {
  const session = { agentId: "coding", sessionId: "session-1" };
  const controller = new AbortController();
  const observed: string[] = [];
  const service: AgentServicePort = {
    listAgents: vi.fn(),
    openSession: vi.fn(),
    dispose: vi.fn(),
    createSession: vi.fn(async () => session),
    closeSession: vi.fn(async () => {
      observed.push("closed");
    }),
    run: vi.fn(async function* (_request, signal) {
      expect(signal).toBe(controller.signal);
      observed.push("run");
      for (const event of events) yield event;
    }),
  };
  return {
    service,
    session,
    controller,
    observed,
    options: {
      service,
      agentId: "coding",
      requestId: "request-1",
      input: "Fix the issue",
      signal: controller.signal,
      onSession: async () => {
        observed.push("started");
      },
      onEvent: (event: AgentServiceEvent) => {
        observed.push(event.type);
      },
    },
  };
}

describe("headless single-task lifecycle", () => {
  it.each([
    [{ type: "completed" }, "completed"],
    [{ type: "failed", code: "model_error", message: "Unavailable", retryable: false }, "failed"],
    [{ type: "cancelled" }, "cancelled"],
  ] as const)(
    "closes its Session after %j without disposing the process-owned Service",
    async (event, status) => {
      const f = fixture([event]);
      expect(await runHeadless(f.options)).toMatchObject({ status });
      expect(f.observed).toEqual(["started", "run", event.type, "closed"]);
      expect(f.service.createSession).toHaveBeenCalledExactlyOnceWith({ agentId: "coding" });
      expect(f.service.run).toHaveBeenCalledExactlyOnceWith(
        { ...f.session, requestId: "request-1", input: { type: "text", text: "Fix the issue" } },
        f.controller.signal,
      );
      expect(f.service.closeSession).toHaveBeenCalledExactlyOnceWith(f.session);
      expect(f.service.dispose).not.toHaveBeenCalled();
    },
  );

  it("does not create a Session for an already cancelled invocation", async () => {
    const f = fixture([]);
    f.controller.abort();
    expect(await runHeadless(f.options)).toEqual({ status: "cancelled" });
    expect(f.service.createSession).not.toHaveBeenCalled();
  });

  it("closes the Session if recording its identity fails before submission", async () => {
    const f = fixture([]);
    await expect(
      runHeadless({
        ...f.options,
        onSession: async () => {
          throw new Error("disk full");
        },
      }),
    ).rejects.toThrow("disk full");
    expect(f.service.run).not.toHaveBeenCalled();
    expect(f.service.closeSession).toHaveBeenCalledExactlyOnceWith(f.session);
  });

  it("rejects an unterminated stream and still closes the Session", async () => {
    const f = fixture([{ type: "text_delta", text: "partial" }]);
    await expect(runHeadless(f.options)).rejects.toThrow("without a terminal event");
    expect(f.service.closeSession).toHaveBeenCalledExactlyOnceWith(f.session);
  });
});
