import type { AgentBlueprintDescriptor, ResolvedAgentComposition } from "@omni-agent/app";

export type AgentInspectionAction = "describe" | "validate" | "plan";

interface SuccessfulInspectionDocument {
  readonly apiVersion: "omni-agent/inspection/v1";
  readonly agentId: string;
  readonly packageName: string;
  readonly packageVersion: string;
}

export interface AgentDescriptionDocument extends SuccessfulInspectionDocument {
  readonly kind: "AgentDescription";
  readonly displayName: string;
  readonly description: string;
  readonly descriptor: AgentBlueprintDescriptor;
}

export interface AgentValidationDocument extends SuccessfulInspectionDocument {
  readonly kind: "AgentValidation";
  readonly valid: true;
}

export interface AgentCompositionPlanDocument extends SuccessfulInspectionDocument {
  readonly kind: "AgentCompositionPlan";
  readonly composition: ResolvedAgentComposition;
}

export interface AgentInspectionErrorDocument {
  readonly apiVersion: "omni-agent/inspection/v1";
  readonly kind: "AgentInspectionError";
  readonly action: AgentInspectionAction;
  readonly agentId: string;
  readonly packageName: string;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly source?: string;
    readonly line?: number;
    readonly column?: number;
    readonly path?: string;
    readonly componentId?: string;
  };
}

export type AgentInspectionDocument =
  | AgentDescriptionDocument
  | AgentValidationDocument
  | AgentCompositionPlanDocument
  | AgentInspectionErrorDocument;
