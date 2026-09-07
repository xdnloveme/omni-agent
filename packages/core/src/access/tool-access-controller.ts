import { createAbortError, throwIfAborted } from "../execution";
import type { ProcessAccessPlan, SandboxPathScope, SandboxPolicy } from "../execution";
import type { ToolResult } from "../types";
import {
  MAX_APPROVED_NETWORK_TARGETS,
  networkTargetKey,
  normalizeNetworkTargets,
  type NetworkCapability,
} from "../network";
import type { AccessConsentBroker, AccessConsentRequest } from "./access-consent-port";
import {
  candidateCanAuthorize,
  capabilityKey,
  isConsentCandidateEligible,
  MAX_APPROVED_FILESYSTEM_ROOTS,
  normalizeFilesystemCapabilities,
  selectNarrowestCapability,
} from "./filesystem-capability";
import type {
  AccessResource,
  ExecutionSettingsPort,
  FilesystemCapabilityScope,
  FilesystemConsentCandidate,
  PreparedToolAccess,
  ToolAccessIntent,
  ToolAccessRequest,
  ToolAccessResult,
  WorkspaceExecutionSettings,
} from "./types";

export interface ToolAccessControllerOptions {
  readonly settings: ExecutionSettingsPort;
  readonly consent: AccessConsentBroker;
}

type FilesystemResource = Extract<AccessResource, { kind: "filesystem" }>;

type AccessEvaluation =
  | { readonly outcome: "allowed"; readonly projected: readonly FilesystemCapabilityScope[] }
  | { readonly outcome: "consent"; readonly request: AccessConsentRequest }
  | { readonly outcome: "denied"; readonly result: ToolResult };

export class ToolAccessController {
  private readonly pendingConsent = new Map<string, ConsentFlight>();
  private readonly preparedAccess = new WeakSet<object>();

  constructor(private readonly options: ToolAccessControllerOptions) {}

  async authorize(request: ToolAccessRequest): Promise<ToolAccessResult> {
    const startedAt = Date.now();
    return this.authorizePrepared(await this.prepare(request), startedAt);
  }

  async prepare(request: ToolAccessRequest): Promise<PreparedToolAccess> {
    throwIfAborted(request.context.signal);
    const input = await this.bindInput(request);
    const intent = await this.assess(request, input);
    const prepared = Object.freeze({
      tool: request.tool,
      input: Object.freeze(input),
      intent: structuredClone(intent),
      context: Object.freeze({ ...request.context }),
    }) as PreparedToolAccess;
    this.preparedAccess.add(prepared);
    return prepared;
  }

  async authorizePrepared(
    prepared: PreparedToolAccess,
    startedAt = Date.now(),
  ): Promise<ToolAccessResult> {
    if (!this.preparedAccess.has(prepared)) throw new Error("Prepared Tool access is invalid");
    const request = { tool: prepared.tool, input: prepared.input, context: prepared.context };
    let settings = await this.readSettings(request);
    const input = prepared.input as Record<string, unknown>;
    const intent = prepared.intent;
    if (intent.hardStop) {
      return {
        ...denied(intent.hardStop.reason, intent.hardStop.code),
        accessMs: Date.now() - startedAt,
      };
    }
    if (intent.denial) {
      return {
        ...denied(intent.denial.reason, intent.denial.code),
        accessMs: Date.now() - startedAt,
      };
    }
    if (settings.mode === "unrestricted") {
      return this.allow(request, input, settings, intent, [], startedAt);
    }
    if (intent.networkScopeRequired) {
      return {
        ...denied(
          "Sandboxed network calls must declare exact network_targets.",
          "network_scope_required",
        ),
        accessMs: Date.now() - startedAt,
      };
    }
    throwIfAborted(request.context.signal);
    const completedConsents = new Set<string>();
    while (true) {
      const decision = this.evaluate(request, settings, intent);
      if (decision.outcome === "denied") {
        return { ...decision, accessMs: Date.now() - startedAt };
      }
      if (decision.outcome === "allowed") {
        return this.allow(request, input, settings, intent, decision.projected, startedAt);
      }

      const key = consentKey(decision.request);
      if (completedConsents.has(key)) {
        throw new Error("Approved access consent did not satisfy the requested capability");
      }
      const response = await this.requestConsent(decision.request, request.context.signal);
      const approved =
        typeof response === "string" ? response === "approve" : response.decision === "approve";
      if (request.context.onPermissionResolved) {
        const detail =
          typeof response === "string"
            ? { permissionId: request.context.toolCallId, decision: response, reason: "user" }
            : response;
        await request.context.onPermissionResolved(detail);
      }
      throwIfAborted(request.context.signal);
      if (!approved) {
        return {
          ...denied(
            "The requested access was not approved. Existing permissions are unchanged.",
            "access_consent_denied",
          ),
          accessMs: Date.now() - startedAt,
        };
      }
      completedConsents.add(key);
      settings = await this.readSettings(request);
    }
  }

  private readSettings(
    request: Pick<ToolAccessRequest, "context">,
  ): Promise<WorkspaceExecutionSettings> {
    return this.options.settings.getSettings(request.context.workspaceId, request.context.agentId);
  }

  private allow(
    request: ToolAccessRequest,
    input: Record<string, unknown>,
    settings: WorkspaceExecutionSettings,
    intent: ToolAccessIntent,
    projected: readonly FilesystemCapabilityScope[],
    startedAt: number,
  ): Extract<ToolAccessResult, { outcome: "allowed" }> {
    const network = networkCapability(intent);
    const processAccess = createProcessAccessPlan(
      settings,
      intent,
      projected,
      request.context.workspaceRoot,
    );
    return {
      outcome: "allowed",
      grant: {
        input,
        mode: settings.mode,
        processAccess,
        executableRequirements: uniqueExecutableRequirements(intent.executableRequirements ?? []),
        ...(network ? { network } : {}),
      },
      accessMs: Date.now() - startedAt,
    };
  }

  private async bindInput(request: ToolAccessRequest): Promise<Record<string, unknown>> {
    const descriptor = request.tool.access;
    if (descriptor.kind !== "dynamic" || !descriptor.bindInput) {
      return structuredClone(request.input) as Record<string, unknown>;
    }
    return descriptor.bindInput(structuredClone(request.input), request.context);
  }

  private async assess(
    request: ToolAccessRequest,
    input: Record<string, unknown>,
  ): Promise<ToolAccessIntent> {
    const descriptor = request.tool.access;
    return descriptor.kind === "internal"
      ? { resources: [] }
      : descriptor.assess(input, request.context);
  }

  private evaluate(
    request: ToolAccessRequest,
    settings: WorkspaceExecutionSettings,
    intent: ToolAccessIntent,
  ): AccessEvaluation {
    if (intent.hardStop) return denied(intent.hardStop.reason, intent.hardStop.code);
    if (intent.denial) return denied(intent.denial.reason, intent.denial.code);
    if (settings.mode === "autonomous") return evaluateAutonomous(intent);
    return evaluateControlled(request, settings, intent);
  }

  private async requestConsent(
    request: AccessConsentRequest,
    signal?: AbortSignal,
  ): Promise<import("./access-consent-port").AccessConsentResponse> {
    const key = consentKey(request);
    const flight = this.pendingConsent.get(key) ?? this.createConsentFlight(key, request);
    flight.waiters += 1;
    try {
      return await waitForConsent(flight.promise, signal);
    } finally {
      flight.waiters -= 1;
      if (flight.waiters === 0 && !flight.settled) {
        if (this.pendingConsent.get(key) === flight) this.pendingConsent.delete(key);
        flight.controller.abort(createAbortError(signal));
      }
    }
  }

  private createConsentFlight(key: string, request: AccessConsentRequest): ConsentFlight {
    const controller = new AbortController();
    const flight: ConsentFlight = {
      controller,
      promise: this.performConsent(request, controller.signal),
      settled: false,
      waiters: 0,
    };
    this.pendingConsent.set(key, flight);
    void flight.promise.then(
      () => this.finishConsentFlight(key, flight),
      () => this.finishConsentFlight(key, flight),
    );
    return flight;
  }

  private finishConsentFlight(key: string, flight: ConsentFlight): void {
    flight.settled = true;
    if (this.pendingConsent.get(key) === flight) this.pendingConsent.delete(key);
  }

  private async performConsent(
    request: AccessConsentRequest,
    signal: AbortSignal,
  ): Promise<import("./access-consent-port").AccessConsentResponse> {
    const response = await this.options.consent.request(request, signal);
    throwIfAborted(signal);
    const approved =
      typeof response === "string" ? response === "approve" : response.decision === "approve";
    if (!approved) return response;
    await this.options.settings.addApprovedAccess(request.workspaceId, request.agentId, {
      scopes: request.scopes,
      targets: request.targets,
    });
    throwIfAborted(signal);
    return response;
  }
}

interface ConsentFlight {
  readonly controller: AbortController;
  readonly promise: Promise<import("./access-consent-port").AccessConsentResponse>;
  settled: boolean;
  waiters: number;
}

function evaluateControlled(
  request: ToolAccessRequest,
  settings: WorkspaceExecutionSettings,
  intent: ToolAccessIntent,
): AccessEvaluation {
  const candidates = (intent.controlledConsentCandidates ?? []).filter(isConsentCandidateEligible);
  const projected: FilesystemCapabilityScope[] = [];
  const missing = new Map<string, FilesystemCapabilityScope>();
  const filesystem = filesystemResources(intent, true);

  for (const resource of filesystem) {
    const invalid = invalidFilesystemResource(resource);
    if (invalid) return invalid;
    if (resource.location === "workspace" && resource.sensitivity === "ordinary") continue;

    const approved = selectNarrowestCapability(settings.approvedFilesystemRoots, resource);
    if (approved) {
      projected.push(approved);
      continue;
    }
    const candidate = candidates.find((entry) => candidateCanAuthorize(entry, resource));
    if (!candidate) {
      const process = intent.resources.some((entry) => entry.kind === "process");
      return denied(
        process
          ? "The command requires an external filesystem scope. Declare it in sandbox_scope."
          : "The requested path is outside the controlled workspace.",
        process ? "sandbox_scope_required" : "filesystem_access_denied",
      );
    }
    missing.set(capabilityKey(candidate.capability), candidate.capability);
  }

  for (const candidate of candidates) {
    const approved = selectNarrowestCapability(
      settings.approvedFilesystemRoots,
      candidateResource(candidate),
    );
    if (approved) projected.push(approved);
    else missing.set(capabilityKey(candidate.capability), candidate.capability);
  }

  if (missing.size > 0) {
    const nextRoots = normalizeFilesystemCapabilities([
      ...settings.approvedFilesystemRoots,
      ...missing.values(),
    ]);
    if (nextRoots.length > MAX_APPROVED_FILESYSTEM_ROOTS) {
      return denied(
        `Controlled filesystem access is limited to ${MAX_APPROVED_FILESYSTEM_ROOTS} approved roots. Revoke an existing root before approving another.`,
        "filesystem_capability_limit",
      );
    }
  }

  const network = networkCapability(intent);
  let missingTargets: NetworkCapability["targets"] = [];
  if (network) {
    const approved = new Set(settings.approvedNetworkTargets.map(networkTargetKey));
    missingTargets = network.targets.filter((target) => !approved.has(networkTargetKey(target)));
    if (
      settings.approvedNetworkTargets.length + missingTargets.length >
      MAX_APPROVED_NETWORK_TARGETS
    ) {
      return denied(
        `Controlled network access is limited to ${MAX_APPROVED_NETWORK_TARGETS} approved targets.`,
        "network_capability_limit",
      );
    }
  }
  if (missing.size > 0 || missingTargets.length > 0) {
    return {
      outcome: "consent",
      request: {
        workspaceId: request.context.workspaceId,
        agentId: request.context.agentId,
        toolName: request.tool.name,
        toolCallId: request.context.toolCallId,
        targets: missingTargets,
        scopes: normalizeFilesystemCapabilities([...missing.values()]),
        purpose: network?.purpose ?? "Filesystem access requested by Tool",
      },
    };
  }
  return { outcome: "allowed", projected: normalizeFilesystemCapabilities(projected) };
}

function evaluateAutonomous(intent: ToolAccessIntent): AccessEvaluation {
  for (const resource of filesystemResources(intent, false)) {
    const invalid = invalidFilesystemResource(resource);
    if (invalid) return invalid;
    if (
      resource.access === "read" &&
      resource.sensitivity === "sensitive" &&
      resource.scope !== "exact"
    ) {
      return denied("Sensitive paths require an exact read scope.", "sensitive_scope_too_broad");
    }
  }
  if (intent.uncoveredResources?.length) {
    return denied(
      "The command requires filesystem access that is not declared in sandbox_scope.",
      "sandbox_scope_required",
    );
  }
  return { outcome: "allowed", projected: [] };
}

function invalidFilesystemResource(resource: FilesystemResource): AccessEvaluation | undefined {
  if (resource.sensitivity === "protected") {
    return denied("The requested path is protected by the execution policy.", "protected_path");
  }
  if (resource.access === "write" && resource.sensitivity !== "ordinary") {
    return denied("Writes to sensitive paths are not allowed.", "sensitive_write");
  }
  return undefined;
}

function filesystemResources(
  intent: ToolAccessIntent,
  includeUncovered: boolean,
): readonly FilesystemResource[] {
  return [
    ...intent.resources,
    ...(includeUncovered ? (intent.uncoveredResources ?? []) : []),
  ].filter((resource): resource is FilesystemResource => resource.kind === "filesystem");
}

function candidateResource(candidate: FilesystemConsentCandidate): FilesystemResource {
  return {
    kind: "filesystem",
    access: candidate.capability.access === "read_write" ? "write" : "read",
    path: candidate.capability.path,
    scope: candidate.capability.scope,
    location: "external",
    sensitivity: candidate.sensitivity,
  };
}

function createProcessAccessPlan(
  settings: WorkspaceExecutionSettings,
  intent: ToolAccessIntent,
  projected: readonly FilesystemCapabilityScope[],
  workspaceRoot: string,
): ProcessAccessPlan {
  if (settings.mode === "unrestricted") {
    return { route: "host" };
  }

  const read: SandboxPathScope[] = [];
  const write: SandboxPathScope[] = [];
  const protectedWriteRoots = new Set<string>([workspaceRoot]);
  if (settings.mode === "autonomous") {
    for (const resource of filesystemResources(intent, false)) {
      const scope = { path: resource.path, scope: resource.scope };
      if (resource.access === "read") read.push(scope);
      else {
        read.push(scope);
        write.push(scope);
        if (resource.scope === "subtree") protectedWriteRoots.add(resource.path);
      }
    }
  } else {
    for (const capability of projected) {
      const scope = { path: capability.path, scope: capability.scope };
      read.push(scope);
      if (capability.access === "read_write") {
        write.push(scope);
        if (capability.scope === "subtree") protectedWriteRoots.add(capability.path);
      }
    }
  }

  const policy: SandboxPolicy = {
    mode: settings.mode,
    workspaceRoot,
    network: { kind: "disabled" },
    read: uniqueSandboxScopes(read),
    write: uniqueSandboxScopes(write),
    protectedWriteRoots: [...protectedWriteRoots].sort(),
  };
  return { route: "sandbox", policy };
}

function uniqueExecutableRequirements(
  requirements: NonNullable<ToolAccessIntent["executableRequirements"]>,
): NonNullable<ToolAccessIntent["executableRequirements"]> {
  const unique = new Map<string, (typeof requirements)[number]>();
  for (const requirement of requirements) {
    unique.set(
      `${requirement.kind}\0${requirement.command}\0${requirement.cwd}\0${requirement.origin}`,
      requirement,
    );
  }
  return [...unique.values()];
}

function uniqueSandboxScopes(scopes: readonly SandboxPathScope[]): readonly SandboxPathScope[] {
  const unique = new Map<string, SandboxPathScope>();
  for (const scope of scopes) unique.set(`${scope.scope}\0${scope.path}`, scope);
  return [...unique.values()].sort((left, right) =>
    `${left.scope}\0${left.path}`.localeCompare(`${right.scope}\0${right.path}`),
  );
}

function consentKey(request: AccessConsentRequest): string {
  return JSON.stringify([
    request.workspaceId,
    request.agentId,
    request.scopes.map(capabilityKey).sort(),
    request.targets.map(networkTargetKey).sort(),
  ]);
}

function networkCapability(intent: ToolAccessIntent): NetworkCapability | undefined {
  const resources = intent.resources.filter(
    (resource): resource is Extract<AccessResource, { kind: "network" }> =>
      resource.kind === "network",
  );
  if (resources.length === 0) return undefined;
  const targets = normalizeNetworkTargets(resources.map((resource) => resource.target));
  const purpose = [...new Set(resources.map((resource) => resource.purpose.trim()).filter(Boolean))]
    .sort()
    .join("; ");
  return { targets, purpose: purpose || "Network access requested by Tool" };
}

function waitForConsent<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(createAbortError(signal));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function denied(message: string, code: string): Extract<AccessEvaluation, { outcome: "denied" }> {
  return {
    outcome: "denied",
    result: {
      content: [{ type: "text", text: message }],
      isError: true,
      meta: { code, retryable: false },
    },
  };
}
