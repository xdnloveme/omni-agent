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
      scopes: [{ path: "/reports", scope: "subtree", access: "read_write" }],
      workspaceId: "workspace",
      agentId: "coding",
      toolName: "web_fetch",
      toolCallId: "call-1",
      targets: [{ scheme: "https", host: "example.com", port: 443 }],
      purpose: "test",
    });
    const filesystem = broker.request({
      targets: [],
      purpose: "Read files",
      workspaceId: "workspace",
      agentId: "coding",
      toolName: "file_read",
      toolCallId: "call-2",
      scopes: [{ path: "/outside\nspoof\u001b[31m", scope: "subtree", access: "read" }],
    });

    await vi.waitFor(() => expect(surface.request).toHaveBeenCalledTimes(1));
    expect(surface.request).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.stringContaining("/reports and all descendants"),
        message: expect.stringContaining("saved together"),
      }),
      undefined,
    );
    expect(surface.request).toHaveBeenCalledWith(
      expect.objectContaining({ detail: expect.stringContaining("https://example.com:443") }),
      undefined,
    );
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
      scopes: [],
      workspaceId: "workspace",
      agentId: "coding",
      toolName: "web_fetch",
      toolCallId: "call-3",
      targets: [{ scheme: "https", host: "example.com", port: 443 }],
      purpose: "test",
    });
    const abort = new AbortController();
    const queued = broker.request(
      {
        scopes: [],
        workspaceId: "workspace",
        agentId: "coding",
        toolName: "bash",
        toolCallId: "call-4",
        targets: [{ scheme: "https", host: "example.com", port: 443 }],
        purpose: "test",
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
