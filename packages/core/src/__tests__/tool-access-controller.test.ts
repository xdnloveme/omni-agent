import { describe, expect, it, vi } from "vitest";
import {
  normalizeFilesystemCapabilities,
  ToolAccessController,
  type AccessConsentResponse,
  type FilesystemCapabilityScope,
  type ToolAccessIntent,
  type WorkspaceExecutionSettings,
} from "../access";
import type { RegisteredAgentTool } from "../types";

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

function request(intent: ToolAccessIntent, toolCallId = "call") {
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
    },
  };
}

function runtime(initial: WorkspaceExecutionSettings, response: AccessConsentResponse = "deny") {
  let settings = initial;
  const broker = { request: vi.fn(async () => response) };
  const enableControlledNetwork = vi.fn(async () => {
    settings = { ...settings, controlledNetworkEnabled: true };
  });
  const addApprovedFilesystemRoots = vi.fn(
    async (_workspaceId: string, _agentId: string, roots: readonly FilesystemCapabilityScope[]) => {
      settings = {
        ...settings,
        approvedFilesystemRoots: normalizeFilesystemCapabilities([
          ...settings.approvedFilesystemRoots,
          ...roots,
        ]),
      };
    },
  );
  return {
    controller: new ToolAccessController({
      settings: {
        getSettings: async () => settings,
        enableControlledNetwork,
        addApprovedFilesystemRoots,
      },
      consent: broker,
    }),
    broker,
    enableControlledNetwork,
    addApprovedFilesystemRoots,
  };
}

const controlled = (): WorkspaceExecutionSettings => ({
  mode: "controlled",
  controlledNetworkEnabled: false,
  approvedFilesystemRoots: [],
});

describe("ToolAccessController", () => {
  it("routes sandboxed modes and bypasses assessment only in unrestricted mode", async () => {
    for (const mode of ["controlled", "autonomous"] as const) {
      const result = await runtime({ ...controlled(), mode }).controller.authorize(
        request({ resources: [{ kind: "process" }] }),
      );
      expect(result).toMatchObject({
        outcome: "allowed",
        grant: { processAccess: { route: "sandbox" } },
      });
    }

    const assess = vi.fn(async () => {
      throw new Error("must not assess unrestricted calls");
    });
    const unrestrictedRequest = request({ resources: [] });
    const result = await runtime({ ...controlled(), mode: "unrestricted" }).controller.authorize({
      ...unrestrictedRequest,
      tool: { ...unrestrictedRequest.tool, access: { kind: "dynamic", assess } },
    });
    expect(result).toMatchObject({
      outcome: "allowed",
      grant: { processAccess: { route: "host" } },
    });
    expect(assess).not.toHaveBeenCalled();
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
    expect(access.addApprovedFilesystemRoots).toHaveBeenCalledTimes(1);
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
        enableControlledNetwork: async () => {
          settings = { ...settings, controlledNetworkEnabled: true };
        },
        addApprovedFilesystemRoots: async () => undefined,
      },
      consent: { request: requestConsent },
    });
    const abort = new AbortController();
    const intent = { resources: [{ kind: "network" as const }] };
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
        enableControlledNetwork: async () => {
          throw new Error("save failed");
        },
        addApprovedFilesystemRoots: async () => undefined,
      },
      consent: { request: async () => "approve" },
    });
    await expect(
      controller.authorize(request({ resources: [{ kind: "network" }] })),
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
