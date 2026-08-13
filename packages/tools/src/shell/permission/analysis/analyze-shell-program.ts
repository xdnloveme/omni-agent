import { throwIfAborted } from "@omni-agent/core";
import {
  applyCommandState,
  commandFact,
  effectsConsumedByCommand,
  resolveCommandFacts,
  resolveRedirectionFact,
} from "../analyzers/command-facts";
import { executableRequirement } from "../analyzers/executable-analyzer";
import { analyzeCommandPaths } from "../analyzers/path-analyzer";
import { analyzeWrapper, type WrapperTargetContext } from "../analyzers/wrapper-analyzer";
import {
  classifyNestedFlow,
  classifyPipelineFlow,
  classifyUnresolvedExecutionFlow,
  enrichCommandEffects,
  isRecursiveBackgroundFunction,
} from "../analyzers/security-flow-analyzer";
import { classifyCommand } from "../classifiers/command-classifiers";
import { classifyCommandHardStop } from "../classifiers/hard-stop-classifier";
import { hardDenyClassification, type ShellClassification } from "../classifiers/types";
import {
  nestedProgramsOfWord,
  parseShellProgram,
  type ShellAssignment,
  type ShellCommandView,
  type ShellProgram,
  type ShellRedirection,
  type ShellStatement,
} from "../parser";
import {
  DYNAMIC_EXECUTION_BUILTINS,
  isApprovalFreeShellBuiltin,
} from "../semantics/shell-builtins";
import { analyzeFindCommand } from "../semantics/find-command-semantics";
import { unknownClassification } from "./aggregate-analysis";
import {
  emptyAnalysis,
  mergeAnalysis,
  producedEffects,
  type AnalyzedShellProgram,
} from "./analysis-accumulator";
import type { ShellAnalysisInput } from "./analysis-input";
import {
  applyPersistentAssignment,
  bindUnknownVariable,
  changeDirectory,
  mergeBranchContexts,
  resolveShellWord,
  type ShellAnalysisContext,
} from "./shell-analysis-context";

const MAX_SEMANTIC_NODES = 4096;
const MAX_NESTED_DEPTH = 16;

export interface ShellAnalysisState {
  nodes: number;
  limitExceeded: boolean;
  resourceExhaustionFunctions: Set<string>;
}

export function createShellAnalysisState(): ShellAnalysisState {
  return { nodes: 0, limitExceeded: false, resourceExhaustionFunctions: new Set() };
}

export async function analyzeShellSource(
  source: string,
  input: ShellAnalysisInput,
  initialContext: ShellAnalysisContext,
  wrapperChain: readonly string[],
  depth: number,
  state: ShellAnalysisState,
): Promise<{ program: ShellProgram; analyzed: AnalyzedShellProgram }> {
  const program = parseShellProgram(source);
  const analyzed = await analyzeShellProgram(
    program,
    input,
    initialContext,
    wrapperChain,
    depth,
    state,
  );
  return { program, analyzed };
}

export async function analyzeShellProgram(
  program: ShellProgram,
  input: ShellAnalysisInput,
  initialContext: ShellAnalysisContext,
  wrapperChain: readonly string[],
  depth: number,
  state: ShellAnalysisState,
): Promise<AnalyzedShellProgram> {
  if (depth > MAX_NESTED_DEPTH) return analysisLimit(initialContext, state);
  let result = emptyAnalysis(initialContext);
  for (const statement of program.body) {
    throwIfAborted(input.signal);
    const current = await analyzeStatement(
      statement,
      input,
      result.context,
      wrapperChain,
      depth,
      state,
    );
    result = mergeAnalysis(result, current, current.context);
    if (state.limitExceeded) break;
  }
  if (program.status !== "complete") {
    result.classifications.push(
      unknownClassification(
        "Shell syntax could not be analyzed completely",
        "shell.unknown.syntax",
      ),
    );
    result.uncertainties.push({
      kind: "unsupported_syntax",
      reason: "Shell syntax could not be analyzed completely",
    });
  }
  return result;
}

async function analyzeStatement(
  statement: ShellStatement,
  input: ShellAnalysisInput,
  context: ShellAnalysisContext,
  wrapperChain: readonly string[],
  depth: number,
  state: ShellAnalysisState,
): Promise<AnalyzedShellProgram> {
  state.nodes += 1;
  if (state.nodes > MAX_SEMANTIC_NODES) return analysisLimit(context, state);

  switch (statement.kind) {
    case "command":
      return analyzeCommand(statement.command, input, context, wrapperChain, depth, state);
    case "assignment": {
      return analyzeAssignments([statement.assignment], input, context, wrapperChain, depth, state);
    }
    case "noop":
      return analyzeNestedPrograms(statement.nested, input, context, wrapperChain, depth, state);
    case "pipeline":
      return analyzePipeline(statement.statements, input, context, wrapperChain, depth, state);
    case "background":
      return analyzeStatement(statement.statement, input, context, wrapperChain, depth, state);
    case "list": {
      const left = await analyzeStatement(
        statement.left,
        input,
        context,
        wrapperChain,
        depth,
        state,
      );
      const right = await analyzeStatement(
        statement.right,
        input,
        statement.operator === "||" ? context : left.context,
        wrapperChain,
        depth,
        state,
      );
      const nextContext =
        statement.operator === ";" ? right.context : mergeBranchContexts(context, right.context);
      return mergeAnalysis(left, right, nextContext);
    }
    case "group": {
      const grouped = await analyzeShellProgram(
        { body: statement.statements, status: "complete" },
        input,
        context,
        wrapperChain,
        depth + 1,
        state,
      );
      return { ...grouped, context: statement.scoped ? context : grouped.context };
    }
    case "loop": {
      const nested = await analyzeNestedPrograms(
        statement.nested,
        input,
        context,
        wrapperChain,
        depth,
        state,
      );
      const condition = await analyzeShellProgram(
        { body: statement.condition, status: "complete" },
        input,
        nested.context,
        wrapperChain,
        depth + 1,
        state,
      );
      const bodyContext = statement.variable
        ? bindUnknownVariable(condition.context, statement.variable, producedEffects(nested))
        : condition.context;
      const body = await analyzeShellProgram(
        { body: statement.body, status: "complete" },
        input,
        bodyContext,
        wrapperChain,
        depth + 1,
        state,
      );
      return mergeAnalysis(
        mergeAnalysis(nested, condition, condition.context),
        body,
        mergeBranchContexts(context, body.context),
      );
    }
    case "branch": {
      const nested = await analyzeNestedPrograms(
        statement.nested,
        input,
        context,
        wrapperChain,
        depth,
        state,
      );
      const condition = await analyzeShellProgram(
        { body: statement.condition, status: "complete" },
        input,
        nested.context,
        wrapperChain,
        depth + 1,
        state,
      );
      let result = mergeAnalysis(nested, condition, condition.context);
      let branchContext = condition.context;
      for (const branch of statement.branches) {
        const analyzed = await analyzeShellProgram(
          { body: branch, status: "complete" },
          input,
          condition.context,
          wrapperChain,
          depth + 1,
          state,
        );
        result = mergeAnalysis(result, analyzed, result.context);
        branchContext = mergeBranchContexts(branchContext, analyzed.context);
      }
      return { ...result, context: branchContext };
    }
    case "function": {
      if (isRecursiveBackgroundFunction(statement.name, statement.statements)) {
        state.resourceExhaustionFunctions.add(statement.name);
      }
      const recovered = await analyzeShellProgram(
        { body: statement.statements, status: "unsupported" },
        input,
        context,
        wrapperChain,
        depth + 1,
        state,
      );
      recovered.uncertainties.push({
        kind: "unsupported_syntax",
        reason: "Shell function definitions are not persistently authorizable",
      });
      return { ...recovered, context };
    }
    case "redirected": {
      const body = await analyzeStatement(
        statement.statement,
        input,
        context,
        wrapperChain,
        depth,
        state,
      );
      const redirections = await analyzeRedirections(statement.redirections, input, body.context);
      const nested = await analyzeNestedPrograms(
        statement.nested,
        input,
        context,
        wrapperChain,
        depth,
        state,
      );
      return mergeAnalysis(mergeAnalysis(body, redirections, body.context), nested, body.context);
    }
    case "unsupported": {
      const recovered = await analyzeShellProgram(
        { body: statement.statements, status: "complete" },
        input,
        context,
        wrapperChain,
        depth + 1,
        state,
      );
      recovered.classifications.push(
        unknownClassification(
          `Unsupported shell syntax: ${statement.syntaxType}`,
          "shell.unknown.syntax",
        ),
      );
      recovered.uncertainties.push({
        kind: "unsupported_syntax",
        reason: `Unsupported shell syntax: ${statement.syntaxType}`,
      });
      return recovered;
    }
  }
}

async function analyzePipeline(
  statements: readonly ShellStatement[],
  input: ShellAnalysisInput,
  context: ShellAnalysisContext,
  wrapperChain: readonly string[],
  depth: number,
  state: ShellAnalysisState,
): Promise<AnalyzedShellProgram> {
  const parts: AnalyzedShellProgram[] = [];
  for (const statement of statements) {
    parts.push(await analyzeStatement(statement, input, context, wrapperChain, depth, state));
  }
  const result = parts.reduce(
    (combined, part) => mergeAnalysis(combined, part, context),
    emptyAnalysis(context),
  );
  const hardStop = classifyPipelineFlow(parts);
  if (hardStop) result.classifications.push(hardStop);
  return result;
}

async function analyzeCommand(
  command: ShellCommandView,
  input: ShellAnalysisInput,
  context: ShellAnalysisContext,
  wrapperChain: readonly string[],
  depth: number,
  state: ShellAnalysisState,
): Promise<AnalyzedShellProgram> {
  const assignments = await analyzeAssignments(
    command.leadingAssignments,
    input,
    context,
    wrapperChain,
    depth,
    state,
  );
  const localContext = assignments.context;
  if (localContext.variableLimitExceeded) state.limitExceeded = true;
  const wrapper = command.executableName ? analyzeWrapper(command) : undefined;
  const findSemantics = analyzeFindCommand(command);
  const wrapperAssignmentPrograms =
    wrapper?.kind === "argv"
      ? (wrapper.targetContext?.assignments.flatMap(({ value }) => nestedProgramsOfWord(value)) ??
        [])
      : [];
  const delegatedPrograms = findSemantics?.delegatedCommands.flatMap(({ nested }) => nested) ?? [];
  const nestedPrograms =
    wrapper?.kind === "argv"
      ? command.nested.filter(
          (program) =>
            !wrapper.target.nested.includes(program) &&
            !wrapperAssignmentPrograms.includes(program),
        )
      : command.nested.filter((program) => !delegatedPrograms.includes(program));
  const commandNested = await analyzeNestedPrograms(
    nestedPrograms,
    input,
    localContext,
    wrapperChain,
    depth,
    state,
  );
  const nested = mergeAnalysis(assignments, commandNested, localContext);
  if (!command.executableName) {
    const flowHardStop = classifyUnresolvedExecutionFlow(nested);
    if (flowHardStop) {
      nested.classifications.push(flowHardStop);
      return { ...nested, context };
    }
    nested.classifications.push(
      unknownClassification(
        "Shell executable cannot be resolved statically",
        "shell.unknown.executable",
      ),
    );
    nested.uncertainties.push({
      kind: "execution_target",
      reason: "Shell executable cannot be resolved statically",
    });
    return { ...nested, context };
  }

  if (state.resourceExhaustionFunctions.has(command.executableName)) {
    const classification = hardDenyClassification(
      "Invokes a recursively expanding background function",
      "shell.hard.resource-exhaustion",
    );
    nested.classifications.push(classification);
    nested.commands.push(commandFact(command, classification, wrapperChain));
    return { ...nested, context };
  }

  const resolvedCommand = resolveCommandFacts(command, localContext);
  const hardStop = classifyCommandHardStop(
    resolvedCommand,
    localContext.cwd,
    input.cwd,
    input.environment.home,
  );
  if (hardStop) {
    nested.classifications.push(hardStop);
    nested.commands.push(commandFact(command, hardStop, wrapperChain));
    return { ...nested, context };
  }
  const consumedEffects = effectsConsumedByCommand(command, localContext);
  const classification = enrichCommandEffects(
    classifyCommand(resolvedCommand),
    resolvedCommand,
    consumedEffects,
  );
  const flowHardStops = classifyNestedFlow(classification, nested, [], consumedEffects);
  if (flowHardStops.length > 0) {
    nested.classifications.push(...flowHardStops);
    nested.commands.push(commandFact(command, classification, wrapperChain));
    return { ...nested, context };
  }
  if (DYNAMIC_EXECUTION_BUILTINS.has(command.executableName)) {
    const classification = unknownClassification(
      `${command.executableName} executes content that cannot be proven statically`,
      "shell.unknown.execution-target",
    );
    nested.classifications.push(classification);
    nested.commands.push(commandFact(command, classification, wrapperChain));
    nested.uncertainties.push({
      kind: "execution_target",
      reason: `${command.executableName} target cannot be resolved statically`,
    });
    return { ...nested, context };
  }

  if (wrapper === null) {
    nested.classifications.push(
      unknownClassification("Wrapper target command is unknown", "shell.unknown.wrapper"),
    );
    nested.uncertainties.push({ kind: "execution_target", reason: "Wrapper target is unknown" });
    return { ...nested, context };
  }
  if (wrapper?.kind === "shell") {
    const wrapperPaths = await analyzePathsForCommand(
      command,
      classifyCommand(resolvedCommand),
      input,
      localContext,
      wrapper.wrapperOperands,
    );
    const target = await analyzeShellSource(
      wrapper.payload,
      input,
      localContext,
      [...wrapperChain, command.executableName],
      depth + 1,
      state,
    );
    return mergeAnalysis(mergeAnalysis(nested, wrapperPaths, context), target.analyzed, context);
  }
  if (wrapper?.kind === "argv") {
    const wrapperPaths = await analyzePathsForCommand(
      command,
      classifyCommand(resolvedCommand),
      input,
      localContext,
      wrapper.wrapperOperands,
    );
    const targetContext = await applyWrapperTargetContext(
      wrapper.targetContext,
      input,
      localContext,
      wrapperChain,
      depth,
      state,
    );
    const target = await analyzeCommand(
      wrapper.target,
      input,
      targetContext.context,
      [...wrapperChain, command.executableName],
      depth + 1,
      state,
    );
    return mergeAnalysis(
      mergeAnalysis(mergeAnalysis(nested, wrapperPaths, context), targetContext, context),
      target,
      context,
    );
  }

  const paths = await analyzePathsForCommand(
    command,
    classification,
    input,
    localContext,
    findSemantics?.pathOperands,
  );
  let result = mergeAnalysis(nested, paths, context);
  result.classifications.push(classification);
  result.classifications.push(
    ...classifyNestedFlow(classification, nested, paths.paths, consumedEffects),
  );
  result.commands.push(commandFact(command, classification, wrapperChain));
  if (wrapper?.kind !== "none" && !isApprovalFreeShellBuiltin(command.executableName)) {
    const requirement = executableRequirement(command);
    if (requirement) result.requirements.push(requirement);
  }
  for (const delegated of findSemantics?.delegatedCommands ?? []) {
    const analyzed = await analyzeCommand(
      delegated,
      input,
      localContext,
      [...wrapperChain, command.executableName],
      depth + 1,
      state,
    );
    result = mergeAnalysis(result, analyzed, context);
  }
  if (findSemantics?.unresolvedDelegation) {
    result.classifications.push(
      unknownClassification("find delegated command cannot be resolved", "shell.unknown.find-exec"),
    );
    result.uncertainties.push({
      kind: "execution_target",
      reason: "find delegated command cannot be resolved",
    });
  }
  const nextContext = applyCommandState(command, context, localContext, producedEffects(nested));
  if (nextContext.variableLimitExceeded) state.limitExceeded = true;
  return { ...result, context: nextContext };
}

async function analyzePathsForCommand(
  command: ShellCommandView,
  classification: ShellClassification,
  input: ShellAnalysisInput,
  context: ShellAnalysisContext,
  operands = command.arguments,
): Promise<AnalyzedShellProgram> {
  const pathAnalysis = await analyzeCommandPaths(command, classification, input, context, {
    operands,
  });
  return {
    ...emptyAnalysis(context),
    paths: [...pathAnalysis.facts],
    uncertainties: pathAnalysis.unresolved
      ? [{ kind: "path", reason: "A shell path cannot be resolved statically" }]
      : [],
  };
}

async function analyzeAssignments(
  assignments: readonly ShellAssignment[],
  input: ShellAnalysisInput,
  context: ShellAnalysisContext,
  wrapperChain: readonly string[],
  depth: number,
  state: ShellAnalysisState,
): Promise<AnalyzedShellProgram> {
  let result = emptyAnalysis(context);
  for (const assignment of assignments) {
    const nested = await analyzeNestedPrograms(
      nestedProgramsOfWord(assignment.value),
      input,
      result.context,
      wrapperChain,
      depth,
      state,
    );
    const nextContext = applyPersistentAssignment(
      result.context,
      assignment,
      producedEffects(nested),
    );
    result = mergeAnalysis(result, nested, nextContext);
    if (nextContext.variableLimitExceeded) state.limitExceeded = true;
  }
  return result;
}

async function applyWrapperTargetContext(
  target: WrapperTargetContext | undefined,
  input: ShellAnalysisInput,
  context: ShellAnalysisContext,
  wrapperChain: readonly string[],
  depth: number,
  state: ShellAnalysisState,
): Promise<AnalyzedShellProgram> {
  if (!target) return emptyAnalysis(context);
  const assignments = await analyzeAssignments(
    target.assignments,
    input,
    context,
    wrapperChain,
    depth,
    state,
  );
  const nextContext = target.cwd
    ? changeDirectory(assignments.context, resolveShellWord(target.cwd, assignments.context))
    : assignments.context;
  return { ...assignments, context: nextContext };
}

async function analyzeRedirections(
  redirections: readonly ShellRedirection[],
  input: ShellAnalysisInput,
  context: ShellAnalysisContext,
): Promise<AnalyzedShellProgram> {
  const fileRedirections = redirections
    .filter(({ target }) => target !== undefined)
    .map((redirection) => resolveRedirectionFact(redirection, context));
  if (fileRedirections.length === 0) return emptyAnalysis(context);
  const command: ShellCommandView = {
    raw: "",
    executable: null,
    executableName: "",
    arguments: [],
    argumentValues: [],
    leadingAssignments: [],
    redirections: fileRedirections,
    nested: [],
    span: { startByte: 0, endByte: 0 },
  };
  const risk = fileRedirections.some(({ operator }) => operator.includes(">")) ? "write" : "read";
  const classification: ShellClassification = {
    risk,
    operationClass: "routine",
    enforcement: "policy",
    reasons: ["Shell redirection accesses a file"],
    ruleIds: [`shell.${risk}.redirection`],
    effects: [],
  };
  const hardStop = classifyCommandHardStop(command, context.cwd, input.cwd, input.environment.home);
  const paths = await analyzePathsForCommand(command, classification, input, context, []);
  if (hardStop) paths.classifications.push(hardStop);
  else if (paths.paths.length > 0 || paths.uncertainties.length > 0) {
    paths.classifications.push(classification);
  }
  return paths;
}

async function analyzeNestedPrograms(
  programs: readonly ShellProgram[],
  input: ShellAnalysisInput,
  context: ShellAnalysisContext,
  wrapperChain: readonly string[],
  depth: number,
  state: ShellAnalysisState,
): Promise<AnalyzedShellProgram> {
  let result = emptyAnalysis(context);
  for (const program of programs) {
    const nested = await analyzeShellProgram(
      program,
      input,
      context,
      wrapperChain,
      depth + 1,
      state,
    );
    result = mergeAnalysis(result, nested, context);
  }
  return result;
}

function analysisLimit(
  context: ShellAnalysisContext,
  state: ShellAnalysisState,
): AnalyzedShellProgram {
  state.limitExceeded = true;
  return emptyAnalysis(context);
}
