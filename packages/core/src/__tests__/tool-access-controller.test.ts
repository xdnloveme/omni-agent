import { describe, expect, it, vi } from "vitest";
import {
  ToolAccessController,
  type AccessConsentResponse,
  type ExecutionSettingsPort,
  type ToolAccessIntent,
  type WorkspaceExecutionSettings,
} from "../access";
import type { RegisteredAgentTool } from "../types";

const networkTarget = { scheme: "https" as const, host: "example.com", port: 443 };

const tool: RegisteredAgentTool = {
  name: "process_test",
  originId: "test",
  toolIdentity: "test:process_test",
  description: "test",
  schema: { type: "object" },
  timeout: { kind: "none" },
  access: { kind: "dynamic", assess: async () => ({ resources: [{ kind: "process" }] }) },
  execution: { kind: "process" },
  createProcessInvocation: () => ({
    command: "true",
    args: [],
    cwd: "/workspace",
    maxOutputBytes: 1024,
  }),
  createToolResult: () => ({ content: [{ type: "text", text: "ok" }], isError: false }),
};

function request(
  intent: ToolAccessIntent,
  toolCallId = "call",
  onPermissionResolved?: NonNullable<import("../access").ToolAccessContext["onPermissionResolved"]>,
) {
  return {
    tool: { ...tool, access: { kind: "dynamic" as const, assess: async () => intent } },
    input: {},
    context: {
      cwd: "/workspace",
      workspaceId: "workspace",
      workspaceRoot: "/workspace",
      agentId: "coding",
      toolCallId,
      hostRuntime: { platform: "darwin" as const, home: "/home/test" },
      ...(onPermissionResolved ? { onPermissionResolved } : {}),
    },
  };
}

function runtime(initial: WorkspaceExecutionSettings, response: AccessConsentResponse = "deny") {
  let settings = initial;
  const broker = { request: vi.fn(async () => response) };
  const addApprovedAccess = vi.fn<ExecutionSettingsPort["addApprovedAccess"]>(
    async (_workspaceId, _agentId, { scopes, targets }) => {
      settings = {
        ...settings,
        approvedNetworkTargets: [...settings.approvedNetworkTargets, ...targets],
        approvedFilesystemRoots: [...settings.approvedFilesystemRoots, ...scopes],
      };
    },
  );
  return {
    controller: new ToolAccessController({
      settings: {
        getSettings: async () => settings,
        addApprovedAccess,
      },
      consent: broker,
    }),
    broker,
    addApprovedAccess,
  };
}

const controlled = (): WorkspaceExecutionSettings => ({
  mode: "controlled",
  approvedNetworkTargets: [],
  approvedFilesystemRoots: [],
});

describe("ToolAccessController", () => {
  const combinedIntent: ToolAccessIntent = {
    resources: [
      {
        kind: "filesystem",
        path: "/outside/report",
        scope: "exact",
        access: "write",
        location: "external",
        sensitivity: "ordinary",
      },
      { kind: "network", target: networkTarget, purpose: "download report" },
    ],
    controlledConsentCandidates: [
      {
        capability: { path: "/outside", scope: "subtree", access: "read_write" },
        sensitivity: "ordinary",
      },
    ],
  };

  it("asks once for all missing access and reuses approval across tools", async () => {
    const access = runtime(controlled(), "approve");
    await expect(access.controller.authorize(request(combinedIntent))).resolves.toMatchObject({
      outcome: "allowed",
    });
    const next = request(combinedIntent, "next");
    await expect(
      access.controller.authorize({ ...next, tool: { ...next.tool, name: "another_tool" } }),
    ).resolves.toMatchObject({ outcome: "allowed" });
    expect(access.broker.request).toHaveBeenCalledTimes(1);
    expect(access.broker.request).toHaveBeenCalledWith(
      expect.objectContaining({
        scopes: [{ path: "/outside", scope: "subtree", access: "read_write" }],
        targets: [networkTarget],
      }),
      expect.any(AbortSignal),
    );
  });

  it("denies the combined request without changing either grant category", async () => {
    const access = runtime(controlled());
    await expect(access.controller.authorize(request(combinedIntent))).resolves.toMatchObject({
      outcome: "denied",
      result: { meta: { code: "access_consent_denied" } },
    });
    expect(access.broker.request).toHaveBeenCalledTimes(1);
    expect(access.addApprovedAccess).not.toHaveBeenCalled();
  });

  it("does not save a late combined approval after its last waiter cancels", async () => {
    let approve!: (response: AccessConsentResponse) => void;
    const consent = {
      request: vi.fn(
        () =>
          new Promise<AccessConsentResponse>((resolve) => {
            approve = resolve;
          }),
      ),
    };
    const save = vi.fn(async () => {});
    const controller = new ToolAccessController({
      settings: { getSettings: async () => controlled(), addApprovedAccess: save },
      consent,
    });
    const abort = new AbortController();
    const call = request(combinedIntent);
    const pending = controller.authorize({
      ...call,
      context: { ...call.context, signal: abort.signal },
    });
    await vi.waitFor(() => expect(consent.request).toHaveBeenCalledOnce());
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    approve("approve");
    await Promise.resolve();
    expect(save).not.toHaveBeenCalled();
  });

  it.each(["autonomous", "unrestricted"] as const)(
    "does not prompt for mixed access in %s",
    async (mode) => {
      const access = runtime({ ...controlled(), mode });
      await expect(access.controller.authorize(request(combinedIntent))).resolves.toMatchObject({
        outcome: "allowed",
      });
      expect(access.broker.request).not.toHaveBeenCalled();
      expect(access.addApprovedAccess).not.toHaveBeenCalled();
    },
  );

  it("persists a local target once and reuses it without repeat consent", async () => {
    const access = runtime(controlled(), "approve");
    const intent: ToolAccessIntent = {
      resources: [
        {
          kind: "network",
          target: { scheme: "http", host: "localhost", port: 3000 },
          purpose: "local development",
        },
      ],
    };
    await expect(access.controller.authorize(request(intent))).resolves.toMatchObject({
      outcome: "allowed",
    });
    await expect(access.controller.authorize(request(intent, "next"))).resolves.toMatchObject({
      outcome: "allowed",
    });
    expect(access.broker.request).toHaveBeenCalledTimes(1);
    expect(access.addApprovedAccess).toHaveBeenCalledWith("workspace", "coding", {
      scopes: [],
      targets: [{ scheme: "http", host: "localhost", port: 3000 }],
    });
  });

  it.each(["controlled", "autonomous", "unrestricted"] as const)(
    "applies undeclared process-network policy in %s at the access owner",
    async (mode) => {
      const result = await runtime({ ...controlled(), mode }).controller.authorize(
        request({ resources: [{ kind: "process" }], networkScopeRequired: true }),
      );
      expect(result).toMatchObject(
        mode === "unrestricted"
          ? { outcome: "allowed", grant: { processAccess: { route: "host" } } }
          : { outcome: "denied", result: { meta: { code: "network_scope_required" } } },
      );
    },
  );
  it("reports the broker correlation when controlled consent resolves", async () => {
    const resolved = vi.fn();
    const { controller } = runtime(controlled(), {
      decision: "approve",
      permissionId: "permission-1",
      reason: "user",
    });
    await controller.authorize(
      request(
        { resources: [{ kind: "network", target: networkTarget, purpose: "test" }] },
        "call",
        resolved,
      ),
    );
    expect(resolved).toHaveBeenCalledWith({
      decision: "approve",
      permissionId: "permission-1",
      reason: "user",
    });
  });

  it("routes sandboxed modes and still assesses unrestricted calls for bounded facts", async () => {
    for (const mode of ["controlled", "autonomous"] as const) {
      const result = await runtime({ ...controlled(), mode }).controller.authorize(
        request({ resources: [{ kind: "process" }] }),
      );
      expect(result).toMatchObject({
        outcome: "allowed",
        grant: { processAccess: { route: "sandbox" } },
      });
    }

    const assess = vi.fn(async () => ({ resources: [] }));
    const unrestrictedRequest = request({ resources: [] });
    const result = await runtime({ ...controlled(), mode: "unrestricted" }).controller.authorize({
      ...unrestrictedRequest,
      tool: { ...unrestrictedRequest.tool, access: { kind: "dynamic", assess } },
    });
    expect(result).toMatchObject({
      outcome: "allowed",
      grant: { processAccess: { route: "host" } },
    });
    expect(assess).toHaveBeenCalledOnce();
  });

  it("keeps hard stops and domain denials active in unrestricted mode", async () => {
    const unrestricted = { ...controlled(), mode: "unrestricted" as const };
    for (const intent of [
      { resources: [], hardStop: { code: "unsafe_command", reason: "Unsafe command" } },
      { resources: [], denial: { code: "invalid_target", reason: "Invalid target" } },
    ] satisfies ToolAccessIntent[]) {
      const result = await runtime(unrestricted).controller.authorize(request(intent));
      expect(result).toMatchObject({ outcome: "denied", result: { isError: true } });
      if (result.outcome === "denied") {
        expect(result.result.meta?.code).toBe(intent.hardStop?.code ?? intent.denial?.code);
      }
    }
  });

  it("preserves structured executable requirements in the access grant", async () => {
    const intent: ToolAccessIntent = {
      resources: [{ kind: "process" }],
      executableRequirements: [
        {
          kind: "host_command",
          command: "gh",
          cwd: "/workspace",
          origin: "shell_command",
        },
      ],
    };
    const result = await runtime(controlled()).controller.authorize(request(intent));
    expect(result).toMatchObject({
      outcome: "allowed",
      grant: {
        processAccess: { route: "sandbox" },
        executableRequirements: [
          {
            kind: "host_command",
            command: "gh",
            cwd: "/workspace",
            origin: "shell_command",
          },
        ],
      },
    });
  });

  it("persists a controlled subtree once and projects only the matching capability", async () => {
    const access = runtime(controlled(), "approve");
    const intent: ToolAccessIntent = {
      resources: [
        { kind: "process" },
        {
          kind: "filesystem",
          access: "write",
          path: "/outside/project/src/file.ts",
          scope: "exact",
          location: "external",
          sensitivity: "ordinary",
        },
      ],
      controlledConsentCandidates: [
        {
          capability: { path: "/outside/project", scope: "subtree", access: "read_write" },
          sensitivity: "ordinary",
        },
      ],
    };
    const first = await access.controller.authorize(request(intent));
    const second = await access.controller.authorize(request(intent, "second"));

    expect(access.broker.request).toHaveBeenCalledTimes(1);
    expect(access.addApprovedAccess).toHaveBeenCalledTimes(1);
    for (const result of [first, second]) {
      expect(result).toMatchObject({
        outcome: "allowed",
        grant: {
          processAccess: {
            policy: {
              read: [{ path: "/outside/project", scope: "subtree" }],
              write: [{ path: "/outside/project", scope: "subtree" }],
              protectedWriteRoots: ["/outside/project", "/workspace"],
            },
          },
        },
      });
    }
  });

  it("keeps read, write, sensitive, and protected capabilities distinct", async () => {
    const settings: WorkspaceExecutionSettings = {
      ...controlled(),
      approvedFilesystemRoots: [{ path: "/outside", scope: "subtree", access: "read" }],
    };
    const write = await runtime(settings).controller.authorize(
      request({
        resources: [
          {
            kind: "filesystem",
            access: "write",
            path: "/outside/file",
            scope: "exact",
            location: "external",
            sensitivity: "ordinary",
          },
        ],
      }),
    );
    const sensitive = await runtime(settings).controller.authorize(
      request({
        resources: [
          {
            kind: "filesystem",
            access: "read",
            path: "/outside/.env",
            scope: "exact",
            location: "external",
            sensitivity: "sensitive",
          },
        ],
      }),
    );
    const protectedPath = await runtime(settings).controller.authorize(
      request({
        resources: [
          {
            kind: "filesystem",
            access: "read",
            path: "/dev/disk0",
            scope: "exact",
            location: "external",
            sensitivity: "protected",
          },
        ],
      }),
    );
    const siblingPrefix = await runtime(settings).controller.authorize(
      request({
        resources: [
          {
            kind: "filesystem",
            access: "read",
            path: "/outside-copy/file",
            scope: "exact",
            location: "external",
            sensitivity: "ordinary",
          },
        ],
      }),
    );
    const exactDirectory = await runtime({
      ...controlled(),
      approvedFilesystemRoots: [{ path: "/outside", scope: "exact", access: "read" }],
    }).controller.authorize(
      request({
        resources: [
          {
            kind: "filesystem",
            access: "read",
            path: "/outside",
            scope: "subtree",
            location: "external",
            sensitivity: "ordinary",
          },
        ],
      }),
    );

    expect(write).toMatchObject({
      outcome: "denied",
      result: { meta: { code: "filesystem_access_denied" } },
    });
    expect(sensitive).toMatchObject({
      outcome: "denied",
      result: { meta: { code: "filesystem_access_denied" } },
    });
    expect(protectedPath).toMatchObject({
      outcome: "denied",
      result: { meta: { code: "protected_path" } },
    });
    expect(siblingPrefix).toMatchObject({
      outcome: "denied",
      result: { meta: { code: "filesystem_access_denied" } },
    });
    expect(exactDirectory).toMatchObject({
      outcome: "denied",
      result: { meta: { code: "filesystem_access_denied" } },
    });
  });

  it("requires autonomous scopes to cover observed access", async () => {
    const access = runtime({ ...controlled(), mode: "autonomous" });
    const result = await access.controller.authorize(
      request({
        resources: [{ kind: "process" }],
        uncoveredResources: [
          {
            kind: "filesystem",
            access: "read",
            path: "/outside/report.txt",
            scope: "exact",
            location: "external",
            sensitivity: "ordinary",
          },
        ],
      }),
    );
    expect(result).toMatchObject({
      outcome: "denied",
      result: { meta: { code: "sandbox_scope_required" } },
    });

    const allowed = await access.controller.authorize(
      request({
        resources: [
          {
            kind: "filesystem",
            access: "write",
            path: "/outside/project",
            scope: "subtree",
            location: "external",
            sensitivity: "ordinary",
          },
        ],
      }),
    );
    expect(allowed).toMatchObject({
      outcome: "allowed",
      grant: {
        processAccess: {
          policy: {
            read: [{ path: "/outside/project", scope: "subtree" }],
            write: [{ path: "/outside/project", scope: "subtree" }],
            protectedWriteRoots: ["/outside/project", "/workspace"],
          },
        },
      },
    });
  });

  it("coalesces controlled network consent without letting one waiter cancel another", async () => {
    let resolveConsent!: (response: AccessConsentResponse) => void;
    const consent = new Promise<AccessConsentResponse>((resolve) => {
      resolveConsent = resolve;
    });
    let settings = controlled();
    const requestConsent = vi.fn(() => consent);
    const controller = new ToolAccessController({
      settings: {
        getSettings: async () => settings,
        addApprovedAccess: async (_workspaceId, _agentId, { targets }) => {
          settings = {
            ...settings,
            approvedNetworkTargets: [...settings.approvedNetworkTargets, ...targets],
          };
        },
      },
      consent: { request: requestConsent },
    });
    const abort = new AbortController();
    const intent = {
      resources: [{ kind: "network" as const, target: networkTarget, purpose: "test" }],
    };
    const first = controller.authorize({
      ...request(intent),
      context: { ...request(intent).context, signal: abort.signal },
    });
    const second = controller.authorize(request(intent, "second"));
    await vi.waitFor(() => expect(requestConsent).toHaveBeenCalledTimes(1));
    abort.abort();
    resolveConsent("approve");

    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    await expect(second).resolves.toMatchObject({ outcome: "allowed" });
  });

  it("fails closed when consent persistence fails", async () => {
    const controller = new ToolAccessController({
      settings: {
        getSettings: async () => controlled(),
        addApprovedAccess: async () => {
          throw new Error("save failed");
        },
      },
      consent: { request: async () => "approve" },
    });
    await expect(
      controller.authorize(
        request({ resources: [{ kind: "network", target: networkTarget, purpose: "test" }] }),
      ),
    ).rejects.toThrow("save failed");
  });

  it("returns a stable denial before exceeding the approved-root limit", async () => {
    const settings: WorkspaceExecutionSettings = {
      ...controlled(),
      approvedFilesystemRoots: Array.from({ length: 64 }, (_, index) => ({
        path: `/approved-${index}`,
        scope: "subtree" as const,
        access: "read" as const,
      })),
    };
    const access = runtime(settings, "approve");
    const result = await access.controller.authorize(
      request({
        resources: [
          {
            kind: "filesystem",
            access: "read",
            path: "/new-root/file",
            scope: "exact",
            location: "external",
            sensitivity: "ordinary",
          },
        ],
        controlledConsentCandidates: [
          {
            capability: { path: "/new-root", scope: "subtree", access: "read" },
            sensitivity: "ordinary",
          },
        ],
      }),
    );

    expect(result).toMatchObject({
      outcome: "denied",
      result: { meta: { code: "filesystem_capability_limit" } },
    });
    expect(access.broker.request).not.toHaveBeenCalled();
  });
});
