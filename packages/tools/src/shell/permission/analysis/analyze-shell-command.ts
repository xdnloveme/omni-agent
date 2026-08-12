import { throwIfAborted, type PersistentApprovalRequirement } from "@omni-agent/core";
import { executableRequirement } from "../analyzers/executable-analyzer";
import { analyzeCommandPaths } from "../analyzers/path-analyzer";
import { analyzeWrapper } from "../analyzers/wrapper-analyzer";
import { classifyCommand } from "../classifiers/command-classifiers";
import {
  classifyCommandHardStop,
  classifyWholeCommandHardStop,
} from "../classifiers/hard-stop-classifier";
import type { ShellClassification } from "../classifiers/types";
import { createShellCommandView, parseShellCommand, type ShellCommandView } from "../parser";
import { aggregateClassifications, unknownClassification } from "./aggregate-analysis";
import type { ShellAnalysisInput } from "./analysis-input";
import type { ShellAnalysisResult, ShellCommandFact, ShellPathFact } from "./analysis-result";

const MAX_WRAPPER_DEPTH = 8;

export async function analyzeShellCommand(input: ShellAnalysisInput): Promise<ShellAnalysisResult> {
  return analyzeParsed(parseShellCommand(input.command), input, [], 0);
}

async function analyzeParsed(
  parsed: ReturnType<typeof parseShellCommand>,
  input: ShellAnalysisInput,
  wrapperChain: readonly string[],
  depth: number,
): Promise<ShellAnalysisResult> {
  throwIfAborted(input.signal);
  const syntax = {
    valid: !parsed.malformed,
    compound: parsed.segments.length > 1,
    dynamic: parsed.hasDynamicExecution,
    segmentCount: parsed.segments.length,
  };
  if (depth > MAX_WRAPPER_DEPTH) {
    return resultFromClassification(
      syntax,
      unknownClassification(
        "Wrapper nesting exceeds the analysis limit",
        "shell.unknown.wrapper-depth",
      ),
    );
  }
  const hardStop = classifyWholeCommandHardStop(parsed, input.cwd, input.environment.home);
  if (hardStop) return resultFromClassification(syntax, hardStop);
  if (parsed.malformed || parsed.hasDynamicExecution) {
    return resultFromClassification(
      syntax,
      unknownClassification(
        "Command contains dynamic or malformed shell syntax",
        "shell.unknown.dynamic",
      ),
    );
  }

  const classifications: ShellClassification[] = [];
  const commands: ShellCommandFact[] = [];
  const paths: ShellPathFact[] = [];
  const requirements: PersistentApprovalRequirement[] = [];
  for (const segment of parsed.segments) {
    throwIfAborted(input.signal);
    const analyzed = await analyzeCommand(
      createShellCommandView(segment),
      input,
      wrapperChain,
      depth,
    );
    classifications.push(...analyzed.classifications);
    commands.push(...analyzed.commands);
    paths.push(...analyzed.paths);
    requirements.push(...analyzed.requirements);
  }
  if (parsed.hasOutputRedirection) {
    classifications.push({
      risk: "write",
      operationClass: "routine",
      enforcement: "policy",
      reasons: ["Shell output redirection writes to a file"],
      ruleIds: ["shell.write.redirection"],
      effects: [],
    });
  }
  const base = aggregateClassifications(classifications);
  const secured = applyPathSecurity(base, paths);
  const credentialTransfer =
    paths.some((fact) => fact.sensitivity === "credential") &&
    base.effects.includes("network_transfer");
  const security = credentialTransfer
    ? aggregateClassifications([
        secured,
        {
          risk: "privileged",
          operationClass: "sensitive",
          enforcement: "hard_deny",
          reasons: ["Uploads credential material"],
          ruleIds: ["shell.hard.credential-transfer"],
          effects: [],
        },
      ])
    : secured;
  const canPersist =
    security.enforcement === "policy" &&
    !["destructive", "privileged"].includes(security.risk) &&
    !syntax.dynamic &&
    paths.every((fact) => fact.sensitivity === null);
  return {
    syntax,
    commands,
    paths,
    effects: [...new Set(base.effects)],
    security: toSecurity(security),
    approvalRequirements: canPersist ? uniqueRequirements(requirements) : [],
  };
}

async function analyzeCommand(
  command: ShellCommandView,
  input: ShellAnalysisInput,
  wrapperChain: readonly string[],
  depth: number,
): Promise<{
  classifications: ShellClassification[];
  commands: ShellCommandFact[];
  paths: ShellPathFact[];
  requirements: PersistentApprovalRequirement[];
}> {
  const segmentHardStop = classifyCommandHardStop(command, input.cwd, input.environment.home);
  if (segmentHardStop) {
    return {
      classifications: [segmentHardStop],
      commands: [commandFact(command, segmentHardStop, wrapperChain)],
      paths: [],
      requirements: [],
    };
  }
  const target = analyzeWrapper(command);
  const wrapper = command.executableName;
  if (target === null) {
    const classification = unknownClassification(
      "Wrapper target command is unknown",
      "shell.unknown.wrapper",
    );
    return { classifications: [classification], commands: [], paths: [], requirements: [] };
  }
  if (target?.kind === "shell" || target?.kind === "argv") {
    const nested =
      target.kind === "shell"
        ? fromNested(
            await analyzeParsed(
              parseShellCommand(target.command),
              input,
              [...wrapperChain, wrapper],
              depth + 1,
            ),
          )
        : await analyzeCommand(target.target, input, [...wrapperChain, wrapper], depth + 1);
    const wrapperClassification = classifyCommand(command);
    return {
      ...nested,
      paths: [
        ...(await analyzeCommandPaths(command, wrapperClassification, input, {
          operands: target.wrapperOperands,
        })),
        ...nested.paths,
      ],
    };
  }
  if (target?.kind === "none") {
    const classification = classifyCommand(command);
    return {
      classifications: [classification],
      commands: [commandFact(command, classification, wrapperChain)],
      paths: await analyzeCommandPaths(command, classification, input),
      requirements: [],
    };
  }

  const classification = classifyCommand(command);
  const requirement = executableRequirement(command);
  return {
    classifications: [classification],
    commands: [commandFact(command, classification, wrapperChain)],
    paths: await analyzeCommandPaths(command, classification, input),
    requirements: requirement ? [requirement] : [],
  };
}

function fromNested(result: ShellAnalysisResult) {
  const classification: ShellClassification = {
    ...result.security,
    reasons: [...result.security.reasons],
    ruleIds: [...result.security.ruleIds],
    effects: [...result.effects],
  };
  return {
    classifications: [classification],
    commands: [...result.commands],
    paths: [...result.paths],
    requirements: [...result.approvalRequirements],
  };
}

function commandFact(
  command: ShellCommandView,
  classification: ShellClassification,
  wrapperChain: readonly string[],
): ShellCommandFact {
  return {
    executable: command.executableName,
    wrapperChain,
    risk: classification.risk,
    operationClass: classification.operationClass,
    reasons: classification.reasons,
    ruleIds: classification.ruleIds,
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
        hardDeny("Command accesses a device path", "shell.path.device"),
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

function hardDeny(reason: string, ruleId: string): ShellClassification {
  return {
    risk: "privileged",
    operationClass: "sensitive",
    enforcement: "hard_deny",
    reasons: [reason],
    ruleIds: [ruleId],
    effects: [],
  };
}

function resultFromClassification(
  syntax: ShellAnalysisResult["syntax"],
  classification: ShellClassification,
): ShellAnalysisResult {
  return {
    syntax,
    commands: [],
    paths: [],
    effects: classification.effects,
    security: toSecurity(classification),
    approvalRequirements: [],
  };
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
