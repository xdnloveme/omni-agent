import {
  AgentCompositionPlanner,
  AgentCompositionPlanningError,
  AgentManifestError,
  AgentPackageCatalogError,
} from "@omni-agent/app";
import type { CliExecutionResult, CliHostServices } from "../host-services";
import { createDefaultAgentPackageCatalog } from "../agents/default-agent-package-catalog";
import { presentInspectionDocument } from "./presentation";
import type {
  AgentInspectionAction,
  AgentInspectionDocument,
  AgentInspectionErrorDocument,
} from "./types";

export async function runAgentInspection(
  action: AgentInspectionAction,
  agentId: string,
  json: boolean,
  host: CliHostServices,
): Promise<CliExecutionResult> {
  const packageName = `@omni-agent/agent-${agentId}`;
  try {
    const loaded = await createDefaultAgentPackageCatalog({
      resolutionBase: host.runtime.cliEntry,
      agentPackagesDirectory: host.runtime.agentPackagesDirectory,
    }).load(agentId);
    const base = {
      apiVersion: "omni-agent/inspection/v1" as const,
      agentId,
      packageName: loaded.packageName,
      packageVersion: loaded.packageVersion,
    };
    let document: AgentInspectionDocument;
    if (action === "describe") {
      document = {
        ...base,
        kind: "AgentDescription",
        displayName: loaded.manifest.metadata.displayName,
        description: loaded.manifest.description,
        descriptor: loaded.blueprint.descriptor,
      };
    } else {
      const composition = new AgentCompositionPlanner().plan(
        loaded.manifest.composition,
        loaded.blueprint.descriptor,
      );
      document =
        action === "validate"
          ? { ...base, kind: "AgentValidation", valid: true }
          : { ...base, kind: "AgentCompositionPlan", composition };
    }
    host.output.stdout(presentInspectionDocument(document, json));
    return { exitCode: 0 };
  } catch (error) {
    const document = inspectionError(action, agentId, packageName, error);
    const output = presentInspectionDocument(document, json);
    if (json) host.output.stdout(output);
    else host.output.stderr(output);
    return { exitCode: 1 };
  }
}

function inspectionError(
  action: AgentInspectionAction,
  agentId: string,
  packageName: string,
  error: unknown,
): AgentInspectionErrorDocument {
  const cause = error instanceof AgentPackageCatalogError ? error.cause : error;
  const manifestError = cause instanceof AgentManifestError ? cause : undefined;
  const planningError = error instanceof AgentCompositionPlanningError ? error : undefined;
  return {
    apiVersion: "omni-agent/inspection/v1",
    kind: "AgentInspectionError",
    action,
    agentId,
    packageName,
    error: {
      code:
        planningError?.code ??
        (error instanceof AgentPackageCatalogError ? error.code : "agent_inspection_failed"),
      message: error instanceof Error ? error.message : String(error),
      ...(manifestError
        ? {
            source: manifestError.source,
            line: manifestError.line,
            column: manifestError.column,
          }
        : {}),
      ...(planningError
        ? { path: planningError.path, componentId: planningError.componentId }
        : {}),
    },
  };
}
