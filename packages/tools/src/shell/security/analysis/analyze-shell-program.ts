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
import { DYNAMIC_EXECUTION_BUILTINS, isShellBuiltinCommand } from "../semantics/shell-builtins";
import {
  analyzeCommandSemantics,
  type ShellCommandSemantics,
} from "../semantics/command-semantics";
import { analyzeFindCommand } from "../semantics/find-command-semantics";
import {
  emptyAnalysis,
  mergeAnalysisFacts,
  continuedContext,
  sameOutcomes,
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
      continuedContext(result),
      wrapperChain,
      depth,
      state,
    );
    result = { ...mergeAnalysisFacts(result, current), outcomes: current.outcomes };
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
    case "background": {
      const result = await analyzeStatement(
        statement.statement,
        input,
        context,
        wrapperChain,
        depth,
        state,
      );
      return { ...result, outcomes: sameOutcomes(context) };
    }
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
        statement.operator === "||"
          ? left.outcomes.failure
          : statement.operator === "&&"
            ? left.outcomes.success
            : continuedContext(left),
        wrapperChain,
        depth,
        state,
      );
      const successContext =
        statement.operator === "||"
          ? mergeBranchContexts(left.outcomes.success, right.outcomes.success)
          : right.outcomes.success;
      const failureContext =
        statement.operator === "&&"
          ? mergeBranchContexts(left.outcomes.failure, right.outcomes.failure)
          : right.outcomes.failure;
      return {
        ...mergeAnalysisFacts(left, right),
        outcomes: { success: successContext, failure: failureContext },
      };
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
      return statement.scoped ? { ...grouped, outcomes: sameOutcomes(context) } : grouped;
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
        continuedContext(nested),
        wrapperChain,
        depth + 1,
        state,
      );
      const bodyContext = statement.variable
        ? bindUnknownVariable(
            continuedContext(condition),
            statement.variable,
            producedEffects(nested),
          )
        : continuedContext(condition);
      const body = await analyzeShellProgram(
        { body: statement.body, status: "complete" },
        input,
        bodyContext,
        wrapperChain,
        depth + 1,
        state,
      );
      return {
        ...mergeAnalysisFacts(mergeAnalysisFacts(nested, condition), body),
        outcomes: sameOutcomes(mergeBranchContexts(context, continuedContext(body))),
      };
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
        continuedContext(nested),
        wrapperChain,
        depth + 1,
        state,
      );
      let result = mergeAnalysisFacts(nested, condition);
      let branchContext = continuedContext(condition);
      for (const branch of statement.branches) {
        const analyzed = await analyzeShellProgram(
          { body: branch, status: "complete" },
          input,
          continuedContext(condition),
          wrapperChain,
          depth + 1,
          state,
        );
        result = mergeAnalysisFacts(result, analyzed);
        branchContext = mergeBranchContexts(branchContext, continuedContext(analyzed));
      }
      return { ...result, outcomes: sameOutcomes(branchContext) };
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
      // Inspect deferred code for security facts without executing its state transitions.
      return { ...recovered, outcomes: sameOutcomes(functionContext) };
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
      const redirections = await analyzeRedirections(statement.redirections, input, context);
      const nested = await analyzeNestedPrograms(
        statement.nested,
        input,
        context,
        wrapperChain,
        depth,
        state,
      );
      // Redirections occur before the body, and can fail without changing its directory.
      const failureContext = mergeBranchContexts(context, body.outcomes.failure);
      const successContext = body.outcomes.success;
      return {
        ...mergeAnalysisFacts(mergeAnalysisFacts(body, redirections), nested),
        outcomes: { success: successContext, failure: failureContext },
      };
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
    (combined, part) => ({
      ...mergeAnalysisFacts(combined, part),
      outcomes: sameOutcomes(context),
    }),
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
  const localContext = continuedContext(assignments);
  if (localContext.variableLimitExceeded) state.limitExceeded = true;
  const wrapper =
    command.executableName &&
    !localContext.shellFunctions.has(command.executable?.staticValue ?? "")
      ? analyzeWrapper(command)
      : undefined;
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
  const nested = mergeAnalysisFacts(assignments, commandNested);
  if (!command.executableName) {
    const flowHardStop = analyzeUnresolvedExecutionFlow(nested);
    if (flowHardStop) {
      nested.hardStops.push(flowHardStop);
      return { ...nested, outcomes: sameOutcomes(context) };
    }
    nested.uncertainties.push({
      kind: "execution_target",
      reason: "Shell executable cannot be resolved statically",
    });
    return { ...nested, outcomes: sameOutcomes(context) };
  }

  if (state.resourceExhaustionFunctions.has(command.executableName)) {
    const hardStop = {
      code: "shell.hard.resource-exhaustion",
      reason: "Invokes a recursively expanding background function",
    };
    const semantics = analyzeCommandSemantics(command, localContext);
    nested.hardStops.push(hardStop);
    nested.commands.push(commandFact(command, semantics, wrapperChain, localContext));
    return { ...nested, outcomes: sameOutcomes(context) };
  }

  const resolvedCommand = resolveCommandFacts(command, localContext);
  const baseSemantics = analyzeCommandSemantics(resolvedCommand, localContext);
  const consumedEffects = effectsConsumedByCommand(command, localContext);
  const semantics: ShellCommandSemantics = {
    ...baseSemantics,
    effects: [...new Set([...baseSemantics.effects, ...consumedEffects])],
  };
  const hardStop = analyzeCommandHardStop(
    resolvedCommand,
    localContext.cwd,
    input.workspaceRoot,
    input.environment.home,
  );
  if (hardStop) {
    nested.hardStops.push(hardStop);
    nested.commands.push(commandFact(command, semantics, wrapperChain, localContext));
    return { ...nested, outcomes: sameOutcomes(context) };
  }
  const flowHardStops = analyzeNestedFlow(semantics.effects, nested, [], consumedEffects);
  if (flowHardStops.length > 0) {
    nested.hardStops.push(...flowHardStops);
    nested.commands.push(commandFact(command, semantics, wrapperChain, localContext));
    return { ...nested, outcomes: sameOutcomes(context) };
  }
  if (DYNAMIC_EXECUTION_BUILTINS.has(command.executableName)) {
    nested.commands.push(commandFact(command, semantics, wrapperChain, localContext));
    nested.uncertainties.push({
      kind: "execution_target",
      reason: `${command.executableName} target cannot be resolved statically`,
    });
    return { ...nested, outcomes: sameOutcomes(context) };
  }

  if (wrapper === null) {
    nested.uncertainties.push({ kind: "execution_target", reason: "Wrapper target is unknown" });
    return { ...nested, outcomes: sameOutcomes(context) };
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
    const wrapperAnalysis = mergeAnalysisFacts(nested, wrapperPaths);
    wrapperAnalysis.effects.push(...semantics.effects);
    wrapperAnalysis.commands.push(commandFact(command, semantics, wrapperChain, localContext));
    return {
      ...mergeAnalysisFacts(wrapperAnalysis, target.analyzed),
      outcomes: sameOutcomes(context),
    };
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
      continuedContext(targetContext),
      [...wrapperChain, command.executableName],
      depth + 1,
      state,
    );
    const sharesState =
      wrapper.stateScope === "current" &&
      isShellBuiltinCommand(command, localContext.shellFunctions);
    return {
      ...mergeAnalysisFacts(
        mergeAnalysisFacts(mergeAnalysisFacts(nested, wrapperPaths), targetContext),
        target,
      ),
      outcomes: sharesState ? target.outcomes : sameOutcomes(context),
    };
  }

  const paths = await analyzePathsForCommand(
    command,
    semantics,
    input,
    localContext,
    findSemantics?.pathOperands,
  );
  let result = mergeAnalysisFacts(nested, paths);
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
    result = mergeAnalysisFacts(result, analyzed);
  }
  if (findSemantics?.unresolvedDelegation) {
    result.uncertainties.push({
      kind: "execution_target",
      reason: "find delegated command cannot be resolved",
    });
  }
  const nextContext = applyCommandState(
    command,
    context,
    localContext,
    producedEffects(nested),
    semantics,
  );
  if (nextContext.variableLimitExceeded) state.limitExceeded = true;
  const failureContext = semantics.directoryChange ? context : nextContext;
  return {
    ...result,
    outcomes: { success: nextContext, failure: failureContext },
  };
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
    uncertainties: [
      ...(pathAnalysis.unresolved
        ? [{ kind: "path" as const, reason: "A shell path cannot be resolved statically" }]
        : []),
      ...(pathAnalysis.unresolvedMutation
        ? [
            {
              kind: "mutation" as const,
              reason: "A command's write targets cannot be bounded statically",
            },
          ]
        : []),
    ],
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
      continuedContext(result),
      wrapperChain,
      depth,
      state,
    );
    const nextContext = applyPersistentAssignment(
      continuedContext(result),
      assignment,
      producedEffects(nested),
    );
    result = { ...mergeAnalysisFacts(result, nested), outcomes: sameOutcomes(nextContext) };
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
  const assignedContext = continuedContext(assignments);
  const nextContext = target.cwd
    ? changeDirectory(assignedContext, resolveShellWord(target.cwd, assignedContext))
    : assignedContext;
  return { ...assignments, outcomes: sameOutcomes(nextContext) };
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
    // There is no executable here. Redirect targets own their individual access effects.
    pathAccess: "read",
    effects: [],
  };
  const hardStop = analyzeCommandHardStop(
    command,
    context.cwd,
    input.workspaceRoot,
    input.environment.home,
  );
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
    result = { ...mergeAnalysisFacts(result, nested), outcomes: sameOutcomes(context) };
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
