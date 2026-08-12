import type { PersistentApprovalRequirement } from "@omni-agent/core";
import { aggregateClassifications } from "./aggregate-analysis";
import { analyzeShellSource, createShellAnalysisState } from "./analyze-shell-program";
import type { ShellAnalysisInput } from "./analysis-input";
import type { ShellAnalysisResult, ShellPathFact, ShellUncertaintyFact } from "./analysis-result";
import { createShellAnalysisContext } from "./shell-analysis-context";
import { hardDenyClassification, type ShellClassification } from "../classifiers/types";
import type { ShellProgram, ShellStatement } from "../parser";

export async function analyzeShellCommand(input: ShellAnalysisInput): Promise<ShellAnalysisResult> {
  const state = createShellAnalysisState();
  const { program, analyzed } = await analyzeShellSource(
    input.command,
    input,
    createShellAnalysisContext(input),
    [],
    0,
    state,
  );
  if (state.limitExceeded) {
    analyzed.classifications.push({
      risk: "unknown",
      operationClass: "sensitive",
      enforcement: "policy",
      reasons: ["Shell analysis exceeded its complexity limit"],
      ruleIds: ["shell.unknown.limit"],
      effects: [],
    });
    analyzed.uncertainties.push({
      kind: "analysis_limit",
      reason: "Shell analysis exceeded its bounded complexity limit",
    });
  }

  const base = aggregateClassifications(analyzed.classifications);
  const secured = applyPathSecurity(base, analyzed.paths);
  const security = secured;
  const blocksPersistence = analyzed.uncertainties.some((fact) =>
    ["execution_target", "unsupported_syntax", "analysis_limit"].includes(fact.kind),
  );
  const canPersist =
    security.enforcement === "policy" &&
    !["destructive", "privileged"].includes(security.risk) &&
    !blocksPersistence &&
    analyzed.paths.every((fact) => fact.sensitivity === null);

  return {
    syntax: {
      status: state.limitExceeded ? "unsupported" : program.status,
      compound: isCompound(program),
      nestedExecution: hasNestedExecution(program),
    },
    commands: analyzed.commands,
    paths: analyzed.paths,
    effects: [...new Set(base.effects)],
    uncertainties: uniqueUncertainties(analyzed.uncertainties),
    security: toSecurity(security),
    approvalRequirements: canPersist ? uniqueRequirements(analyzed.requirements) : [],
  };
}

function applyPathSecurity(
  classification: ShellClassification,
  paths: readonly ShellPathFact[],
): ShellClassification {
  let result = classification;
  for (const fact of paths) {
    if (fact.sensitivity === "device") {
      result = aggregateClassifications([
        result,
        hardDenyClassification("Command accesses a device path", "shell.path.device"),
      ]);
    } else if (fact.sensitivity) {
      result = aggregateClassifications([
        result,
        {
          risk: fact.access === "read" && result.risk === "read" ? "external" : "privileged",
          operationClass: "sensitive",
          enforcement: "policy",
          reasons: [`Command accesses a sensitive ${fact.sensitivity} path`],
          ruleIds: [`shell.path.sensitive.${fact.sensitivity}`],
          effects: [],
        },
      ]);
    } else if (fact.location === "external" && ["read", "write", "execute"].includes(result.risk)) {
      result = aggregateClassifications([
        result,
        {
          risk: "external",
          operationClass: "sensitive",
          enforcement: "policy",
          reasons: ["Command accesses a path outside the workspace"],
          ruleIds: ["shell.path.outside-workspace"],
          effects: [],
        },
      ]);
    }
  }
  return result;
}

function toSecurity(classification: ShellClassification): ShellAnalysisResult["security"] {
  return {
    risk: classification.risk,
    operationClass: classification.operationClass,
    enforcement: classification.enforcement,
    reasons: [...new Set(classification.reasons)],
    ruleIds: [...new Set(classification.ruleIds)],
  };
}

function uniqueRequirements(
  requirements: readonly PersistentApprovalRequirement[],
): PersistentApprovalRequirement[] {
  return [...new Map(requirements.map((entry) => [entry.approval.key, entry])).values()];
}

function uniqueUncertainties(
  uncertainties: readonly ShellUncertaintyFact[],
): ShellUncertaintyFact[] {
  return [
    ...new Map(uncertainties.map((entry) => [`${entry.kind}\0${entry.reason}`, entry])).values(),
  ];
}

function isCompound(program: ShellProgram): boolean {
  return program.body.length > 1 || program.body.some(isCompoundStatement);
}

function isCompoundStatement(statement: ShellStatement): boolean {
  return ["pipeline", "list", "group", "background", "function"].includes(statement.kind);
}

function hasNestedExecution(program: ShellProgram): boolean {
  return program.body.some((statement) => {
    if (statement.kind === "command") return statement.command.nested.length > 0;
    if (statement.kind === "assignment") return statement.nested.length > 0;
    if (
      statement.kind === "pipeline" ||
      statement.kind === "group" ||
      statement.kind === "function" ||
      statement.kind === "unsupported"
    ) {
      return statement.statements.some((child) =>
        hasNestedExecution({ body: [child], status: "complete" }),
      );
    }
    if (statement.kind === "list") {
      return hasNestedExecution({
        body: [statement.left, statement.right],
        status: "complete",
      });
    }
    if (statement.kind === "background") {
      return hasNestedExecution({ body: [statement.statement], status: "complete" });
    }
    return (
      statement.nested.length > 0 ||
      hasNestedExecution({ body: [statement.statement], status: "complete" })
    );
  });
}
