import type { RegisteredAgentTool, ToolResult } from "../types";
import { assertJsonObject } from "../data";
import { throwIfAborted, type AuthorizedToolCall } from "../execution";
import { createAuthorizedToolCall } from "../execution/authorized-tool-call";
import type {
  ApprovalBroker,
  PermissionGrantStore,
  PermissionObserver,
  PermissionPolicy,
} from "./ports";
import { sanitizePermissionLabel, sanitizePermissionPresentation } from "./presentation";
import type {
  PermissionAssessment,
  PermissionContext,
  PermissionDecisionSource,
  PermissionGrant,
  PersistentApprovalRequirement,
  PersistentApprovalScope,
  ToolPermissionDescriptor,
} from "./types";
import {
  createToolRoutineApprovalScope,
  isPersistentApprovalReference,
  isPersistentApprovalScope,
} from "./persistent-approval";

export type PermissionControlledTool = RegisteredAgentTool & {
  authorization: ToolPermissionDescriptor;
};

export interface PermissionGateRequest {
  tool: PermissionControlledTool;
  input: Record<string, unknown>;
  context: PermissionContext;
}

export type PermissionGateResult =
  | {
      outcome: "allowed";
      call: AuthorizedToolCall;
      assessment: PermissionAssessment;
      authorizationMs: number;
      source: Exclude<PermissionDecisionSource, "hard_stop">;
    }
  | {
      outcome: "denied";
      result: ToolResult;
      assessment: PermissionAssessment;
      authorizationMs: number;
      source: "policy" | "user" | "hard_stop";
    };

export interface PermissionGateOptions {
  policy: PermissionPolicy;
  grants: PermissionGrantStore;
  broker: ApprovalBroker;
  observer?: PermissionObserver;
}

export class PermissionGate {
  constructor(private readonly options: PermissionGateOptions) {}

  async authorize(request: PermissionGateRequest): Promise<PermissionGateResult> {
    const startedAt = Date.now();
    throwIfAborted(request.context.signal);
    const binder =
      request.tool.authorization.kind === "dynamic"
        ? request.tool.authorization.bindInput
        : undefined;
    const boundInput = binder
      ? await binder(structuredClone(request.input) as Record<string, unknown>, request.context)
      : request.input;
    assertJsonObject(boundInput, `Dynamic authorization input for ${request.tool.name}`);
    throwIfAborted(request.context.signal);
    const candidateCall = createAuthorizedToolCall(request.tool, boundInput, {
      cwd: request.context.cwd,
      signal: request.context.signal,
    });
    const assessment = await this.assess({
      ...request,
      input: structuredClone(candidateCall.input) as Record<string, unknown>,
    });
    throwIfAborted(request.context.signal);

    if (assessment.enforcement === "hard_deny") {
      return this.resolveDenied(request, assessment, "hard_stop", startedAt);
    }

    const mode = await this.options.grants.getMode(request.context.agentId);
    const decision = await this.options.policy.evaluate({
      agentId: request.context.agentId,
      toolIdentity: request.context.toolIdentity,
      toolName: request.tool.name,
      mode,
      assessment,
    });
    assertPermissionDecision(decision);
    throwIfAborted(request.context.signal);

    if (decision.outcome === "deny") {
      return this.resolveDenied(request, assessment, "policy", startedAt);
    }
    if (decision.outcome === "allow") {
      return this.resolveAllowed(request, candidateCall, assessment, "policy", startedAt);
    }
    const requiredApprovals = resolvePersistentApprovals(request.tool.name, assessment, decision);
    const candidates = uniqueGrantCandidates(requiredApprovals);
    const grantedKeys = requiredApprovals.length
      ? await this.options.grants.getGrantedScopeKeys(
          request.context.agentId,
          request.context.toolIdentity,
          candidates,
        )
      : [];
    const granted = new Set(grantedKeys);
    const missingApprovals = requiredApprovals.filter((requirement) =>
      requirement.satisfiedBy.every(({ key }) => !granted.has(key)),
    );
    if (requiredApprovals.length > 0 && missingApprovals.length === 0) {
      return this.resolveAllowed(
        request,
        candidateCall,
        assessment,
        "automatic_approval",
        startedAt,
      );
    }

    await this.observeRequested(request, assessment);
    const response = await this.options.broker.request(
      {
        agentId: request.context.agentId,
        toolCallId: request.context.toolCallId,
        toolIdentity: request.context.toolIdentity,
        toolName: request.tool.name,
        risk: assessment.risk,
        presentation: assessment.presentation,
        ...(missingApprovals.length
          ? {
              persistentApprovals: missingApprovals.map(({ approval: { kind, label } }) => ({
                kind,
                label,
              })),
            }
          : {}),
      },
      request.context.signal,
    );
    throwIfAborted(request.context.signal);
    if (response === "deny") {
      return this.resolveDenied(request, assessment, "user", startedAt);
    }
    if (response === "allow_always") {
      if (missingApprovals.length === 0) {
        return this.resolveDenied(request, assessment, "policy", startedAt);
      }
      const grants: PermissionGrant[] = missingApprovals.map(({ approval }) => ({
        toolIdentity: request.context.toolIdentity,
        toolName: request.tool.name,
        scopeKey: approval.key,
        scopeKind: approval.kind,
        label: approval.label,
      }));
      await this.options.grants.saveGrants(request.context.agentId, grants);
      throwIfAborted(request.context.signal);
    } else if (response !== "allow_once") {
      return this.resolveDenied(request, assessment, "policy", startedAt);
    }
    return this.resolveAllowed(request, candidateCall, assessment, "user", startedAt);
  }

  private async assess(request: PermissionGateRequest): Promise<PermissionAssessment> {
    const descriptor = request.tool.authorization;
    const assessment =
      descriptor.kind === "static"
        ? {
            risk: descriptor.risk,
            operationClass: "routine" as const,
            enforcement: "policy" as const,
            reasons: [descriptor.reason],
            ruleIds: [],
            presentation: { title: request.tool.name, reason: descriptor.reason },
          }
        : await descriptor.assess(request.input, request.context);
    assertPermissionAssessment(assessment);
    const sanitized = {
      ...assessment,
      ...(assessment.persistentApprovalRequirements
        ? {
            persistentApprovalRequirements: assessment.persistentApprovalRequirements.map(
              (requirement) => ({
                ...requirement,
                approval: {
                  ...requirement.approval,
                  label: sanitizePermissionLabel(requirement.approval.label),
                },
              }),
            ),
          }
        : {}),
      presentation: sanitizePermissionPresentation(assessment.presentation),
    };
    assertPermissionAssessment(sanitized);
    return sanitized;
  }

  private async resolveAllowed(
    request: PermissionGateRequest,
    call: AuthorizedToolCall,
    assessment: PermissionAssessment,
    source: "policy" | "automatic_approval" | "user",
    startedAt: number,
  ): Promise<PermissionGateResult> {
    await this.observeResolved(request, assessment, "allow", source);
    throwIfAborted(request.context.signal);
    return {
      outcome: "allowed",
      call,
      assessment,
      authorizationMs: Date.now() - startedAt,
      source,
    };
  }

  private async resolveDenied(
    request: PermissionGateRequest,
    assessment: PermissionAssessment,
    source: "policy" | "user" | "hard_stop",
    startedAt: number,
  ): Promise<PermissionGateResult> {
    await this.observeResolved(request, assessment, "deny", source);
    throwIfAborted(request.context.signal);
    return denied(assessment, source, startedAt);
  }

  private event(request: PermissionGateRequest, assessment: PermissionAssessment) {
    return {
      agentId: request.context.agentId,
      toolIdentity: request.context.toolIdentity,
      toolName: request.tool.name,
      risk: assessment.risk,
      ruleIds: assessment.ruleIds,
      timestamp: Date.now(),
    } as const;
  }

  private async observeRequested(
    request: PermissionGateRequest,
    assessment: PermissionAssessment,
  ): Promise<void> {
    await safelyObserve(() =>
      this.options.observer?.onRequested?.(this.event(request, assessment)),
    );
  }

  private async observeResolved(
    request: PermissionGateRequest,
    assessment: PermissionAssessment,
    outcome: "allow" | "deny",
    source: PermissionDecisionSource,
  ): Promise<void> {
    await safelyObserve(() =>
      this.options.observer?.onResolved?.({ ...this.event(request, assessment), outcome, source }),
    );
  }
}

function uniqueGrantCandidates(
  requirements: readonly PersistentApprovalRequirement[],
): Array<{ key: string; kind: PersistentApprovalScope["kind"] }> {
  return [
    ...new Map(
      requirements.flatMap(({ satisfiedBy }) =>
        satisfiedBy.map((reference) => [`${reference.kind}\0${reference.key}`, reference] as const),
      ),
    ).values(),
  ];
}

const PERMISSION_RISKS = new Set([
  "read",
  "write",
  "execute",
  "external_read",
  "external",
  "destructive",
  "privileged",
  "unknown",
]);
const POLICY_OUTCOMES = new Set(["allow", "ask", "deny"]);

function assertPermissionAssessment(value: PermissionAssessment): void {
  if (!value || typeof value !== "object") throw new Error("Permission assessment is invalid");
  if (!PERMISSION_RISKS.has(value.risk)) throw new Error("Permission assessment risk is invalid");
  if (value.operationClass !== "routine" && value.operationClass !== "sensitive") {
    throw new Error("Permission assessment operation class is invalid");
  }
  if (value.persistentApprovalRequirements !== undefined) {
    if (!Array.isArray(value.persistentApprovalRequirements)) {
      throw new Error("Persistent approval scopes are invalid");
    }
    const keys = new Set<string>();
    for (const requirement of value.persistentApprovalRequirements) {
      assertPersistentApprovalRequirement(requirement);
      if (keys.has(requirement.approval.key)) {
        throw new Error("Persistent approval scopes contain duplicates");
      }
      keys.add(requirement.approval.key);
    }
  }
  if (value.enforcement !== "policy" && value.enforcement !== "hard_deny") {
    throw new Error("Permission assessment enforcement is invalid");
  }
  if (
    !Array.isArray(value.reasons) ||
    !value.reasons.every((reason) => typeof reason === "string")
  ) {
    throw new Error("Permission assessment reasons are invalid");
  }
  if (
    !Array.isArray(value.ruleIds) ||
    !value.ruleIds.every((ruleId) => typeof ruleId === "string")
  ) {
    throw new Error("Permission assessment rule IDs are invalid");
  }
  if (
    !value.presentation ||
    typeof value.presentation.title !== "string" ||
    typeof value.presentation.reason !== "string" ||
    (value.presentation.detail !== undefined && typeof value.presentation.detail !== "string")
  ) {
    throw new Error("Permission assessment presentation is invalid");
  }
}

function resolvePersistentApprovals(
  toolName: string,
  assessment: PermissionAssessment,
  decision: { outcome: "ask"; canAllowAlways: boolean },
): readonly PersistentApprovalRequirement[] {
  if (!decision.canAllowAlways) return [];
  return (
    assessment.persistentApprovalRequirements ?? [
      requirement(createToolRoutineApprovalScope(toolName)),
    ]
  );
}

function requirement(approval: PersistentApprovalScope): PersistentApprovalRequirement {
  return { approval, satisfiedBy: [{ key: approval.key, kind: approval.kind }] };
}

function assertPersistentApprovalRequirement(value: PersistentApprovalRequirement): void {
  if (!value || typeof value !== "object") {
    throw new Error("Persistent approval requirement is invalid");
  }
  assertPersistentApprovalScope(value.approval);
  if (
    !Array.isArray(value.satisfiedBy) ||
    value.satisfiedBy.length === 0 ||
    !value.satisfiedBy.every(isPersistentApprovalReference) ||
    new Set(value.satisfiedBy.map(({ kind, key }) => `${kind}\0${key}`)).size !==
      value.satisfiedBy.length
  ) {
    throw new Error("Persistent approval requirement satisfaction keys are invalid");
  }
}

function assertPersistentApprovalScope(value: PersistentApprovalScope): void {
  if (!isPersistentApprovalScope(value)) throw new Error("Persistent approval scope is invalid");
}

function assertPermissionDecision(value: unknown): void {
  if (!value || typeof value !== "object") throw new Error("Permission policy decision is invalid");
  const decision = value as { outcome?: unknown; reason?: unknown; canAllowAlways?: unknown };
  if (typeof decision.outcome !== "string" || !POLICY_OUTCOMES.has(decision.outcome)) {
    throw new Error("Permission policy outcome is invalid");
  }
  if (typeof decision.reason !== "string") {
    throw new Error("Permission policy reason is invalid");
  }
  if (decision.outcome === "ask" && typeof decision.canAllowAlways !== "boolean") {
    throw new Error("Permission policy persistence decision is invalid");
  }
}

function denied(
  assessment: PermissionAssessment,
  source: "policy" | "user" | "hard_stop",
  startedAt: number,
): PermissionGateResult {
  return {
    outcome: "denied",
    result: {
      content: [{ type: "text", text: "Tool execution denied by permission policy." }],
      isError: true,
      meta: { code: "permission_denied", risk: assessment.risk, source },
    },
    assessment,
    authorizationMs: Date.now() - startedAt,
    source,
  };
}

async function safelyObserve(callback: () => void | Promise<void> | undefined): Promise<void> {
  try {
    await callback();
  } catch {
    // Observability must not affect permission decisions.
  }
}
