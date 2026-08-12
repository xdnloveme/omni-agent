import type {
  PermissionPolicy,
  PermissionPolicyDecision,
  PermissionPolicyContext,
} from "@omni-agent/core";

export class DefaultPermissionPolicy implements PermissionPolicy {
  evaluate(context: PermissionPolicyContext): PermissionPolicyDecision {
    const matrix = evaluateRiskMatrix(context);
    if (matrix.outcome !== "ask") return matrix;
    return {
      ...matrix,
      canAllowAlways: isPersistentApprovalEligible(context),
    };
  }
}

function evaluateRiskMatrix(context: PermissionPolicyContext): PermissionPolicyDecision {
  const { risk } = context.assessment;
  if (risk === "read") return { outcome: "allow", reason: "Read-only operation" };
  if (risk === "write" && context.mode === "standard") {
    return { outcome: "allow", reason: "Workspace writes are allowed in standard mode" };
  }
  if (risk === "external_read" && context.mode === "standard") {
    return { outcome: "allow", reason: "Routine external reads are allowed in standard mode" };
  }
  return {
    outcome: "ask",
    reason: context.assessment.presentation.reason,
    canAllowAlways: false,
  };
}

function isPersistentApprovalEligible(context: PermissionPolicyContext): boolean {
  const { assessment } = context;
  if (assessment.risk === "destructive" || assessment.risk === "privileged") return false;
  if (assessment.persistentApprovalRequirements?.length) return true;
  if (assessment.operationClass !== "routine") return false;
  return ["write", "execute", "external", "external_read"].includes(assessment.risk);
}
