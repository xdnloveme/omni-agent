import { describe, expect, it, vi } from "vitest";
import type {
  InteractionRequest,
  InteractionResponse,
  InteractionSurfacePort,
} from "@omni-agent/core";
import { TuiAccessConsentBroker } from "./tui-access-consent-broker";

describe("TuiAccessConsentBroker", () => {
  it("serializes distinct access requests through the foreground surface", async () => {
    const pending: Array<(response: InteractionResponse) => void> = [];
    const surface: InteractionSurfacePort = {
      request: vi.fn((request: InteractionRequest) =>
        new Promise<InteractionResponse>((resolve) => pending.push(resolve)).then((response) => ({
          ...response,
          requestId: request.requestId,
        })),
      ),
    };
    const broker = new TuiAccessConsentBroker(surface);
    const network = broker.request({
      kind: "network",
      workspaceId: "workspace",
      agentId: "coding",
      toolName: "web_fetch",
    });
    const filesystem = broker.request({
      kind: "filesystem",
      workspaceId: "workspace",
      agentId: "coding",
      toolName: "file_read",
      scopes: [{ path: "/outside\nspoof\u001b[31m", scope: "subtree", access: "read" }],
    });

    await vi.waitFor(() => expect(surface.request).toHaveBeenCalledTimes(1));
    pending.shift()?.({ requestId: "replaced", kind: "dismissed", values: {} });
    await expect(network).resolves.toBe("deny");
    await vi.waitFor(() => expect(surface.request).toHaveBeenCalledTimes(2));
    expect(surface.request).toHaveBeenLastCalledWith(
      expect.objectContaining({
        detail: expect.stringContaining("/outside\\nspoof and all descendants"),
      }),
      undefined,
    );
    pending.shift()?.({
      requestId: "replaced",
      kind: "completed",
      values: { access: { type: "single", optionId: "approve" } },
    });
    await expect(filesystem).resolves.toBe("approve");
  });

  it("removes an aborted queued request before it reaches the surface", async () => {
    let finishActive!: (response: InteractionResponse) => void;
    const surface: InteractionSurfacePort = {
      request: vi.fn(
        (request: InteractionRequest) =>
          new Promise<InteractionResponse>((resolve) => {
            finishActive = (response) => resolve({ ...response, requestId: request.requestId });
          }),
      ),
    };
    const broker = new TuiAccessConsentBroker(surface);
    const active = broker.request({
      kind: "network",
      workspaceId: "workspace",
      agentId: "coding",
      toolName: "web_fetch",
    });
    const abort = new AbortController();
    const queued = broker.request(
      {
        kind: "network",
        workspaceId: "workspace",
        agentId: "coding",
        toolName: "bash",
      },
      abort.signal,
    );

    abort.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    finishActive({ requestId: "replaced", kind: "dismissed", values: {} });
    await expect(active).resolves.toBe("deny");
    expect(surface.request).toHaveBeenCalledTimes(1);
  });
});
