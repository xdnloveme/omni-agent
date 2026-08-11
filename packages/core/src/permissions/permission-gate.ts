import type { RegisteredAgentTool, ToolResult } from "../types";
import { throwIfAborted, type AuthorizedToolCall } from "../execution";
import { createAuthorizedToolCall } from "../execution/authorized-tool-call";
import type {
  ApprovalBroker,
  PermissionGrantStore,
  PermissionObserver,
  PermissionPolicy,
} from "./ports";
import { sanitizePermissionPresentation } from "./presentation";
import type {
  PermissionAssessment,
  PermissionContext,
  PermissionDecisionSource,
  ToolPermissionDescriptor,
} from "./types";

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
    const candidateCall = createAuthorizedToolCall(request.tool, request.input, {
      cwd: request.context.cwd,
      signal: request.context.signal,
    });
    const assessment = await this.assess({
      ...request,
      input: structuredClone(candidateCall.input) as Record<string, unknown>,
    });
    throwIfAborted(request.context.signal);

    if (assessment.enforcement === "hard_deny") {
      await this.observeResolved(request, assessment, "deny", "hard_stop");
      throwIfAborted(request.context.signal);
      return denied(assessment, "hard_stop", startedAt);
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
      await this.observeResolved(request, assessment, "deny", "policy");
      throwIfAborted(request.context.signal);
      return denied(assessment, "policy", startedAt);
    }
    if (decision.outcome === "allow") {
      await this.observeResolved(request, assessment, "allow", "policy");
      throwIfAborted(request.context.signal);
      return this.allowed(candidateCall, assessment, "policy", startedAt);
    }
    if (
      decision.canAllowAlways &&
      (await this.options.grants.isToolAlwaysApproved(
        request.context.agentId,
        request.context.toolIdentity,
      ))
    ) {
      await this.observeResolved(request, assessment, "allow", "automatic_approval");
      throwIfAborted(request.context.signal);
      return this.allowed(candidateCall, assessment, "automatic_approval", startedAt);
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
        canAllowAlways: decision.canAllowAlways,
      },
      request.context.signal,
    );
    throwIfAborted(request.context.signal);
    if (response === "deny") {
      await this.observeResolved(request, assessment, "deny", "user");
      throwIfAborted(request.context.signal);
      return denied(assessment, "user", startedAt);
    }
    if (response === "allow_always") {
      if (!decision.canAllowAlways) {
        await this.observeResolved(request, assessment, "deny", "policy");
        throwIfAborted(request.context.signal);
        return denied(assessment, "policy", startedAt);
      }
      await this.options.grants.approveTool(
        request.context.agentId,
        request.context.toolIdentity,
        request.tool.name,
      );
      throwIfAborted(request.context.signal);
    } else if (response !== "allow_once") {
      await this.observeResolved(request, assessment, "deny", "policy");
      throwIfAborted(request.context.signal);
      return denied(assessment, "policy", startedAt);
    }
    await this.observeResolved(request, assessment, "allow", "user");
    throwIfAborted(request.context.signal);
    return this.allowed(candidateCall, assessment, "user", startedAt);
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
    return {
      ...assessment,
      presentation: sanitizePermissionPresentation(assessment.presentation),
    };
  }

  private allowed(
    call: AuthorizedToolCall,
    assessment: PermissionAssessment,
    source: "policy" | "automatic_approval" | "user",
    startedAt: number,
  ): PermissionGateResult {
    return {
      outcome: "allowed",
      call,
      assessment,
      authorizationMs: Date.now() - startedAt,
      source,
    };
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
