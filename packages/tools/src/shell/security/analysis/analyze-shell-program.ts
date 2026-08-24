import { throwIfAborted } from "@omni-agent/core";
import {
  applyCommandState,
  commandFact,
  effectsConsumedByCommand,
  resolveCommandFacts,
  resolveRedirectionFact,
} from "../analyzers/command-facts";
import { analyzeCommandPaths } from "../analyzers/path-analyzer";
import { analyzeWrapper, type WrapperTargetContext } from "../analyzers/wrapper-analyzer";
import {
  analyzeNestedFlow,
  analyzePipelineFlow,
  analyzeUnresolvedExecutionFlow,
  isRecursiveBackgroundFunction,
} from "../analyzers/security-flow-analyzer";
import { analyzeCommandHardStop } from "../analyzers/hard-stop-analyzer";
import {
  nestedProgramsOfWord,
  parseShellProgram,
  type ShellAssignment,
  type ShellCommandView,
  type ShellProgram,
  type ShellRedirection,
  type ShellStatement,
} from "../parser";
import { DYNAMIC_EXECUTION_BUILTINS } from "../semantics/shell-builtins";
import {
  analyzeCommandSemantics,
  type ShellCommandSemantics,
} from "../semantics/command-semantics";
import { analyzeFindCommand } from "../semantics/find-command-semantics";
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
  defineShellFunction,
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
      const functionContext = defineShellFunction(context, statement.name);
      const recovered = await analyzeShellProgram(
        { body: statement.statements, status: "unsupported" },
        input,
        functionContext,
        wrapperChain,
        depth + 1,
        state,
      );
      recovered.uncertainties.push({
        kind: "unsupported_syntax",
        reason: "Shell function definitions cannot be analyzed completely",
      });
      return { ...recovered, context: functionContext };
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
  const hardStop = analyzePipelineFlow(parts);
  if (hardStop) result.hardStops.push(hardStop);
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
    const flowHardStop = analyzeUnresolvedExecutionFlow(nested);
    if (flowHardStop) {
      nested.hardStops.push(flowHardStop);
      return { ...nested, context };
    }
    nested.uncertainties.push({
      kind: "execution_target",
      reason: "Shell executable cannot be resolved statically",
    });
    return { ...nested, context };
  }

  if (state.resourceExhaustionFunctions.has(command.executableName)) {
    const hardStop = {
      code: "shell.hard.resource-exhaustion",
      reason: "Invokes a recursively expanding background function",
    };
    const semantics = analyzeCommandSemantics(command);
    nested.hardStops.push(hardStop);
    nested.commands.push(commandFact(command, semantics, wrapperChain, localContext));
    return { ...nested, context };
  }

  const resolvedCommand = resolveCommandFacts(command, localContext);
  const baseSemantics = analyzeCommandSemantics(resolvedCommand);
  const consumedEffects = effectsConsumedByCommand(command, localContext);
  const semantics: ShellCommandSemantics = {
    ...baseSemantics,
    effects: [...new Set([...baseSemantics.effects, ...consumedEffects])],
  };
  const hardStop = analyzeCommandHardStop(
    resolvedCommand,
    localContext.cwd,
    input.cwd,
    input.environment.home,
  );
  if (hardStop) {
    nested.hardStops.push(hardStop);
    nested.commands.push(commandFact(command, semantics, wrapperChain, localContext));
    return { ...nested, context };
  }
  const flowHardStops = analyzeNestedFlow(semantics.effects, nested, [], consumedEffects);
  if (flowHardStops.length > 0) {
    nested.hardStops.push(...flowHardStops);
    nested.commands.push(commandFact(command, semantics, wrapperChain, localContext));
    return { ...nested, context };
  }
  if (DYNAMIC_EXECUTION_BUILTINS.has(command.executableName)) {
    nested.commands.push(commandFact(command, semantics, wrapperChain, localContext));
    nested.uncertainties.push({
      kind: "execution_target",
      reason: `${command.executableName} target cannot be resolved statically`,
    });
    return { ...nested, context };
  }

  if (wrapper === null) {
    nested.uncertainties.push({ kind: "execution_target", reason: "Wrapper target is unknown" });
    return { ...nested, context };
  }
  if (wrapper?.kind === "shell") {
    const wrapperPaths = await analyzePathsForCommand(
      command,
      semantics,
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
    const wrapperAnalysis = mergeAnalysis(nested, wrapperPaths, context);
    wrapperAnalysis.effects.push(...semantics.effects);
    wrapperAnalysis.commands.push(commandFact(command, semantics, wrapperChain, localContext));
    return mergeAnalysis(wrapperAnalysis, target.analyzed, context);
  }
  if (wrapper?.kind === "argv") {
    const wrapperPaths = await analyzePathsForCommand(
      command,
      semantics,
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
    semantics,
    input,
    localContext,
    findSemantics?.pathOperands,
  );
  let result = mergeAnalysis(nested, paths, context);
  result.effects.push(...semantics.effects);
  result.hardStops.push(
    ...analyzeNestedFlow(semantics.effects, nested, paths.paths, consumedEffects),
  );
  result.commands.push(commandFact(command, semantics, wrapperChain, localContext));
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
  semantics: ShellCommandSemantics,
  input: ShellAnalysisInput,
  context: ShellAnalysisContext,
  operands = command.arguments,
): Promise<AnalyzedShellProgram> {
  const pathAnalysis = await analyzeCommandPaths(command, semantics, input, context, {
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
  const semantics: ShellCommandSemantics = {
    pathAccess: fileRedirections.some(({ operator }) => operator.includes(">")) ? "write" : "read",
    effects: [],
  };
  const hardStop = analyzeCommandHardStop(command, context.cwd, input.cwd, input.environment.home);
  const paths = await analyzePathsForCommand(command, semantics, input, context, []);
  if (hardStop) paths.hardStops.push(hardStop);
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
