import type { ShellHardStop, ShellPathFact } from "../analysis/analysis-result";
import type { ShellStatement } from "../parser";
import type { ShellEffect } from "../semantics/command-semantics";

export interface ShellSecurityFlowPart {
  readonly effects: readonly ShellEffect[];
  readonly paths: readonly ShellPathFact[];
}

export function analyzeNestedFlow(
  commandEffects: readonly ShellEffect[],
  nested: ShellSecurityFlowPart,
  paths: readonly ShellPathFact[],
  consumedEffects: readonly ShellEffect[] = [],
): ShellHardStop[] {
  const nestedEffects = [...nested.effects, ...consumedEffects];
  const hardStops: ShellHardStop[] = [];
  if (
    commandEffects.includes("interpreter") &&
    (nestedEffects.includes("download") || nestedEffects.includes("decode"))
  ) {
    hardStops.push(
      hardStop("shell.hard.nested-execute", "Executes content produced by a nested command"),
    );
  }
  if (
    commandEffects.includes("network_transfer") &&
    (nestedEffects.includes("credential_read") || hasCredentialRead([...nested.paths, ...paths]))
  ) {
    hardStops.push(hardStop("shell.hard.credential-transfer", "Uploads credential material"));
  }
  return hardStops;
}

export function analyzeUnresolvedExecutionFlow(
  nested: ShellSecurityFlowPart,
): ShellHardStop | null {
  return nested.effects.includes("download") || nested.effects.includes("decode")
    ? hardStop(
        "shell.hard.dynamic-execute",
        "Executes a command produced by untrusted transformed content",
      )
    : null;
}

export function analyzePipelineFlow(parts: readonly ShellSecurityFlowPart[]): ShellHardStop | null {
  for (let index = 0; index < parts.length; index += 1) {
    const source = parts[index]!;
    const later = parts.slice(index + 1).flatMap(({ effects }) => effects);
    if (source.effects.includes("download") && later.includes("interpreter")) {
      return hardStop("shell.hard.download-execute", "Executes downloaded code");
    }
    if (source.effects.includes("decode") && later.includes("interpreter")) {
      return hardStop("shell.hard.decode-execute", "Decodes and executes an opaque payload");
    }
    if (
      (source.effects.includes("credential_read") || hasCredentialRead(source.paths)) &&
      later.includes("network_transfer")
    ) {
      return hardStop("shell.hard.credential-transfer", "Uploads credential material");
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

function hardStop(code: string, reason: string): ShellHardStop {
  return { code, reason };
}

function hasCredentialRead(paths: readonly ShellPathFact[]): boolean {
  return paths.some(
    ({ access, sensitivity }) => sensitivity === "credential" && access !== "write",
  );
}
