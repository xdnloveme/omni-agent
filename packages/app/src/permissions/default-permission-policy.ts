import type {
  PermissionPolicy,
  PermissionPolicyDecision,
  PermissionPolicyContext,
} from "@omni-agent/core";

export class DefaultPermissionPolicy implements PermissionPolicy {
  evaluate(context: PermissionPolicyContext): PermissionPolicyDecision {
    const { risk } = context.assessment;
    if (risk === "read") return { outcome: "allow", reason: "Read-only operation" };
    if (risk === "external_read") {
      return context.mode === "standard"
        ? { outcome: "allow", reason: "Read-only network access is allowed in standard mode" }
        : { outcome: "ask", reason: context.assessment.presentation.reason, canAllowAlways: false };
    }
    if (risk === "external" && context.assessment.operationClass === "routine") {
      return {
        outcome: "ask",
        reason: context.assessment.presentation.reason,
        canAllowAlways: true,
      };
    }
    if (["external", "destructive", "privileged", "unknown"].includes(risk)) {
      return {
        outcome: "ask",
        reason: context.assessment.presentation.reason,
        canAllowAlways: false,
      };
    }
    if (risk === "write" && context.mode === "standard") {
      return { outcome: "allow", reason: "Workspace writes are allowed in standard mode" };
    }
    return {
      outcome: "ask",
      reason: context.assessment.presentation.reason,
      canAllowAlways: context.assessment.operationClass === "routine",
    };
  }
}
