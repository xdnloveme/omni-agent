import { producedEffects } from "./analysis-accumulator";
import { analyzeShellSource, createShellAnalysisState } from "./analyze-shell-program";
import type { ShellAnalysisInput } from "./analysis-input";
import type { ShellAnalysisResult, ShellUncertaintyFact } from "./analysis-result";
import { createShellAnalysisContext } from "./shell-analysis-context";
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
    analyzed.uncertainties.push({
      kind: "analysis_limit",
      reason: "Shell analysis exceeded its bounded complexity limit",
    });
  }

  return {
    syntax: {
      status: state.limitExceeded ? "unsupported" : program.status,
      compound: isCompound(program),
      nestedExecution: hasNestedExecution(program),
    },
    commands: analyzed.commands,
    paths: analyzed.paths,
    effects: producedEffects(analyzed),
    uncertainties: uniqueUncertainties(analyzed.uncertainties),
    security: analyzed.hardStops[0] ? { hardStop: analyzed.hardStops[0] } : {},
  };
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
  return ["pipeline", "list", "group", "loop", "branch", "background", "function"].includes(
    statement.kind,
  );
}

function hasNestedExecution(program: ShellProgram): boolean {
  return program.body.some((statement) => {
    if (statement.kind === "command") return statement.command.nested.length > 0;
    if (statement.kind === "assignment") return statement.nested.length > 0;
    if (statement.kind === "noop") return statement.nested.length > 0;
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
    if (statement.kind === "loop") {
      return (
        statement.nested.length > 0 ||
        hasNestedExecution({
          body: [...statement.condition, ...statement.body],
          status: "complete",
        })
      );
    }
    if (statement.kind === "branch") {
      return (
        statement.nested.length > 0 ||
        hasNestedExecution({
          body: [...statement.condition, ...statement.branches.flat()],
          status: "complete",
        })
      );
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
