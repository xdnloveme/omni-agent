import { aggregateClassifications } from "../analysis/aggregate-analysis";
import type { ShellPathFact } from "../analysis/analysis-result";
import {
  hardDenyClassification,
  type ShellClassification,
  type ShellEffect,
} from "../classifiers/types";
import type { ShellCommandView, ShellStatement } from "../parser";

export interface ShellSecurityFlowPart {
  classifications: readonly ShellClassification[];
  paths: readonly ShellPathFact[];
}

export function enrichCommandEffects(
  classification: ShellClassification,
  command: ShellCommandView,
  consumedEffects: readonly ShellEffect[] = [],
): ShellClassification {
  const effects: ShellEffect[] = [...classification.effects, ...consumedEffects];
  if (
    (command.executableName === "base64" &&
      command.argumentValues.some((argument) => argument === "-d" || argument === "--decode")) ||
    (command.executableName === "openssl" && command.argumentValues.includes("base64"))
  ) {
    effects.push("decode");
  }
  if (command.executableName === "eval") effects.push("interpreter");
  return { ...classification, effects: [...new Set(effects)] };
}

export function classifyNestedFlow(
  command: ShellClassification,
  nested: ShellSecurityFlowPart,
  paths: readonly ShellPathFact[],
  consumedEffects: readonly ShellEffect[] = [],
): ShellClassification[] {
  const nestedEffects = [
    ...aggregateClassifications(nested.classifications).effects,
    ...consumedEffects,
  ];
  const hardStops: ShellClassification[] = [];
  if (
    command.effects.includes("interpreter") &&
    (nestedEffects.includes("download") || nestedEffects.includes("decode"))
  ) {
    hardStops.push(
      hardDenyClassification(
        "Executes content produced by a nested command",
        "shell.hard.nested-execute",
      ),
    );
  }
  if (
    command.effects.includes("network_transfer") &&
    (nestedEffects.includes("credential_read") || hasCredentialRead([...nested.paths, ...paths]))
  ) {
    hardStops.push(
      hardDenyClassification("Uploads credential material", "shell.hard.credential-transfer"),
    );
  }
  return hardStops;
}

export function classifyUnresolvedExecutionFlow(
  nested: ShellSecurityFlowPart,
): ShellClassification | null {
  const effects = aggregateClassifications(nested.classifications).effects;
  return effects.includes("download") || effects.includes("decode")
    ? hardDenyClassification(
        "Executes a command produced by untrusted transformed content",
        "shell.hard.dynamic-execute",
      )
    : null;
}

export function classifyPipelineFlow(
  parts: readonly ShellSecurityFlowPart[],
): ShellClassification | null {
  const effects = parts.map((part) => aggregateClassifications(part.classifications).effects);
  for (let index = 0; index < effects.length; index += 1) {
    const source = effects[index]!;
    const later = effects.slice(index + 1).flat();
    if (source.includes("download") && later.includes("interpreter")) {
      return hardDenyClassification("Executes downloaded code", "shell.hard.download-execute");
    }
    if (source.includes("decode") && later.includes("interpreter")) {
      return hardDenyClassification(
        "Decodes and executes an opaque payload",
        "shell.hard.decode-execute",
      );
    }
    if (
      (source.includes("credential_read") || hasCredentialRead(parts[index]!.paths)) &&
      later.includes("network_transfer")
    ) {
      return hardDenyClassification(
        "Uploads credential material",
        "shell.hard.credential-transfer",
      );
    }
  }
  return null;
}

export function isRecursiveBackgroundFunction(
  name: string,
  statements: readonly ShellStatement[],
): boolean {
  let recursiveCalls = 0;
  let background = false;
  const visit = (statement: ShellStatement): void => {
    if (statement.kind === "command") {
      if (statement.command.executableName === name) recursiveCalls += 1;
      return;
    }
    if (statement.kind === "background") {
      background = true;
      visit(statement.statement);
      return;
    }
    if (statement.kind === "list") {
      visit(statement.left);
      visit(statement.right);
      return;
    }
    if (statement.kind === "redirected") {
      visit(statement.statement);
      return;
    }
    if (statement.kind === "loop") {
      statement.condition.forEach(visit);
      statement.body.forEach(visit);
      return;
    }
    if (statement.kind === "branch") {
      statement.condition.forEach(visit);
      statement.branches.flat().forEach(visit);
      return;
    }
    if (
      statement.kind === "pipeline" ||
      statement.kind === "group" ||
      statement.kind === "function" ||
      statement.kind === "unsupported"
    ) {
      statement.statements.forEach(visit);
    }
  };
  statements.forEach(visit);
  return background && recursiveCalls >= 2;
}

function hasCredentialRead(paths: readonly ShellPathFact[]): boolean {
  return paths.some(
    ({ access, sensitivity }) => sensitivity === "credential" && access !== "write",
  );
}
