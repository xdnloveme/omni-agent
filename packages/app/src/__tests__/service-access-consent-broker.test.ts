import { describe, expect, it, vi } from "vitest";
import { AgentServiceAccessConsentBroker } from "../application/permissions/service-access-consent-broker";

function networkRequest(): import("@omni-agent/core").AccessConsentRequest {
  return {
    scopes: [],
    workspaceId: "ws",
    agentId: "coding",
    toolName: "web_fetch",
    toolCallId: "call",
    targets: [{ scheme: "http", host: "localhost", port: 3000 }],
    purpose: "test",
  };
}

describe("AgentServiceAccessConsentBroker", () => {
  it("presents every mixed resource and fails closed instead of truncating approval", async () => {
    const broker = new AgentServiceAccessConsentBroker();
    const presentations: Array<{ resources: readonly string[]; title: string }> = [];
    const events: string[] = [];
    broker.subscribe((event) => {
      events.push(event.type);
      if (event.type === "requested") {
        presentations.push(event.presentation);
        broker.resolve(event.permissionId, "approve");
      }
    });
    const request = {
      ...networkRequest(),
      scopes: Array.from({ length: 64 }, (_, index) => ({
        path: `/scope-${index}`,
        scope: "subtree" as const,
        access: "read" as const,
      })),
      targets: Array.from({ length: 64 }, (_, index) => ({
        scheme: "https" as const,
        host: `host-${index}.test`,
        port: 443,
      })),
    };
    expect(await broker.request(request)).toMatchObject({ decision: "approve" });
    expect(presentations[0]?.resources).toHaveLength(128);
    expect(presentations[0]?.title).toContain("Agent: coding");
    const eventCount = events.length;
    await expect(
      broker.request({
        ...request,
        scopes: [{ path: "/" + "a".repeat(513), scope: "exact", access: "read" }],
      }),
    ).rejects.toThrow("Permission presentation exceeds the host display limits");
    expect(events).toHaveLength(eventCount);
    expect(presentations).toHaveLength(1);
  });

  it.each(["cancelled", "disconnected", "expired"] as const)(
    "settles %s while delivery remains blocked",
    async (reason) => {
      vi.useFakeTimers();
      let release!: () => void;
      const delivery = new Promise<void>((resolve) => {
        release = resolve;
      });
      const broker = new AgentServiceAccessConsentBroker();
      const events: Array<{ type: string; permissionId: string }> = [];
      const detach = broker.subscribe((event) => {
        events.push(event);
        if (event.type === "requested") return delivery;
      });
      const abort = new AbortController();
      try {
        const pending = broker.request(networkRequest(), abort.signal);
        await Promise.resolve();
        if (reason === "cancelled") abort.abort();
        else if (reason === "disconnected") detach();
        else await vi.advanceTimersByTimeAsync(60_000);
        await expect(pending).resolves.toMatchObject({ decision: "deny", reason });
        expect(broker.resolve(events[0]!.permissionId, "approve")).toBe(false);
      } finally {
        release();
        detach();
        vi.useRealTimers();
      }
    },
  );

  it("does not let late delivery failure replace approval or escape from a synchronous resolved sink", async () => {
    const broker = new AgentServiceAccessConsentBroker();
    let fail!: (error: Error) => void;
    const delivery = new Promise<void>((_resolve, reject) => {
      fail = reject;
    });
    let id = "";
    broker.subscribe((event) => {
      if (event.type === "requested") {
        id = event.permissionId;
        return delivery;
      }
      throw new Error("resolved delivery failed");
    });
    const pending = broker.request(networkRequest());
    await Promise.resolve();
    expect(broker.resolve(id, "approve")).toBe(true);
    fail(new Error("late send failure"));
    await expect(pending).resolves.toMatchObject({ decision: "approve", reason: "user" });
    expect(broker.resolve(id, "deny")).toBe(false);
  });
  it("correlates a bounded request and publishes its resolution", async () => {
    const broker = new AgentServiceAccessConsentBroker();
    const events: unknown[] = [];
    broker.subscribe((event) => {
      events.push(event);
    });
    const pending = broker.request({
      scopes: [],
      workspaceId: "ws",
      agentId: "coding",
      toolName: "web_fetch",
      toolCallId: "call-1",
      targets: [{ scheme: "https", host: "example.com", port: 443 }],
      purpose: "fetch",
    });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    const permissionId = (events[0] as { permissionId: string }).permissionId;
    expect(broker.resolve(permissionId, "approve")).toBe(true);
    await expect(pending).resolves.toMatchObject({
      decision: "approve",
      permissionId,
      reason: "user",
    });
    await vi.waitFor(() => expect(events).toHaveLength(2));
    expect(events[1]).toMatchObject({
      type: "resolved",
      requestId: "call-1",
      decision: "approve",
      reason: "user",
    });
  });
});
