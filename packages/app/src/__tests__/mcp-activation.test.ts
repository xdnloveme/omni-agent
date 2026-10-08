import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ToolAccessController,
  ToolCallCoordinator,
  ToolInputValidator,
  ToolInvocationRunner,
} from "@omni-agent/core";
import { AgentMcpController } from "../mcp/agent-mcp-controller";
import { McpActivationStore } from "../mcp/activation-store";
import { McpCatalogService } from "../mcp/catalog/mcp-catalog-service";
import { ToolRegistry } from "../registry/tool-registry";
import type { McpSdkClient } from "../mcp/client/sdk-client";
import { parseMcpConfiguration } from "../mcp/config/types";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "omni-mcp-activation-"));
  directories.push(root);
  const store = new McpActivationStore(join(root, "activation.json"));
  const discover = vi.fn(async () => ({
    tools: [{ name: "search", inputSchema: { type: "object" as const } }],
    instructions: "Search documentation",
  }));
  const close = vi.fn(async () => undefined);
  const catalog = new McpCatalogService(new ToolRegistry(), {
    discover,
    close,
  } as unknown as McpSdkClient);
  const coordinator = new ToolCallCoordinator({
    inputValidator: new ToolInputValidator(),
    hostRuntime: { platform: "darwin", home: root },
    accessController: new ToolAccessController({
      settings: {
        getSettings: async () => ({
          mode: "controlled",
          approvedNetworkTargets: [],
          approvedFilesystemRoots: [],
        }),
        addApprovedAccess: async () => {},
      },
      consent: { request: async () => "deny" },
    }),
    processPlanner: {
      prepare: async () => {
        throw new Error("unexpected process");
      },
    },
    invocationRunner: new ToolInvocationRunner({
      processRouter: {
        run: async () => {
          throw new Error("unexpected process");
        },
      },
    }),
  });
  const create = () =>
    new AgentMcpController(
      parseMcpConfiguration(
        {
          servers: [
            { id: "docs", transport: "stdio", command: "configured-server" },
            { id: "remote", transport: "streamable_http", url: "https://example.com/mcp" },
            { id: "linear", transport: "streamable_http", url: "invalid-url" },
          ],
        },
        "project",
      ),
      store,
      catalog,
      coordinator,
      {
        agentId: "coding",
        workspaceId: "workspace",
        workspaceRoot: root,
        cwd: root,
        middleware: [],
        lifecycleAdapters: [],
      },
    );
  return { store, discover, close, create, catalog };
}

describe("Agent MCP activation", () => {
  it("does not commit a catalog that arrives after cancellation", async () => {
    const { catalog, discover, close } = await fixture();
    const abort = new AbortController();
    discover.mockImplementationOnce(async () => {
      abort.abort();
      return { tools: [{ name: "late", inputSchema: { type: "object" } }], instructions: "late" };
    });
    await expect(
      catalog.refresh({ id: "docs", transport: "stdio", command: "server" }, abort.signal),
    ).rejects.toThrow();
    expect(catalog.tools()).toEqual([]);
    expect(close).toHaveBeenCalledWith("docs");
    expect(catalog.instructions()).toEqual([]);
  });

  it("keeps distinct server ownership for hyphens and underscores", async () => {
    const { catalog } = await fixture();
    await catalog.refresh({ id: "docs-one", transport: "stdio", command: "server" });
    await catalog.refresh({ id: "docs_one", transport: "stdio", command: "server" });
    await catalog.deactivate("docs-one");
    expect(catalog.tools().map((tool) => tool.name)).toEqual(["mcp__docs_one__search"]);
  });
  it("loads only persisted switches and removes tools and instructions on disable", async () => {
    const { create, store, discover } = await fixture();
    await store.set("linear", true);
    const controller = create();
    await controller.initialize();
    expect(discover).not.toHaveBeenCalled();
    expect(controller.list()).toContainEqual(
      expect.objectContaining({
        id: "linear",
        status: "invalid",
        configurationError: expect.objectContaining({ source: "project", index: 2 }),
      }),
    );
    await expect(controller.setEnabled("linear", true)).rejects.toThrow();
    await controller.setEnabled("docs", true);
    expect(controller.tools().map((tool) => tool.name)).toEqual(["mcp__docs__search"]);
    expect(controller.prompt()).toContain("Search documentation");
    expect(await store.read()).toEqual(["docs", "linear"]);
    await controller.close();
    const restored = create();
    await restored.initialize();
    expect(restored.list()[0]).toMatchObject({ enabled: true, status: "ready", toolCount: 1 });
    await restored.setEnabled("docs", false);
    expect(restored.tools()).toEqual([]);
    expect(restored.prompt()).toBe("");
    expect(await store.read()).toEqual(["linear"]);
  });

  it("keeps activation intent on failure and does not register a partial catalog", async () => {
    const { create, discover } = await fixture();
    discover.mockRejectedValueOnce(new Error("server offline"));
    const controller = create();
    await controller.setEnabled("docs", true);
    expect(controller.list()[0]).toMatchObject({ enabled: true, status: "failed", toolCount: 0 });
    await controller.retry("docs");
    expect(controller.list()[0]).toMatchObject({ status: "ready", toolCount: 1 });
  });

  it("keeps disable committed when transport cleanup fails", async () => {
    const { create, store, close } = await fixture();
    const controller = create();
    await controller.setEnabled("docs", true);
    close.mockRejectedValueOnce(new Error("close failed"));
    await expect(controller.setEnabled("docs", false)).rejects.toThrow("close failed");
    expect(controller.list()[0]).toMatchObject({
      enabled: false,
      status: "disabled",
      toolCount: 0,
    });
    expect(controller.tools()).toEqual([]);
    expect(controller.prompt()).toBe("");
    expect(await store.read()).toEqual([]);
  });

  it("does not contact an HTTP server when target consent is denied", async () => {
    const { create, discover } = await fixture();
    const controller = create();
    await controller.setEnabled("remote", true);
    expect(discover).not.toHaveBeenCalled();
    expect(controller.list()[1]).toMatchObject({ enabled: true, status: "failed", toolCount: 0 });
  });
});
