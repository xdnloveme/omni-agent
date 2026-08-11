import os from "node:os";
import path from "node:path";
import { canonicalizeToolPath } from "../../security/path/normalize-path";
import { isWithinPath } from "../../security/path/path-boundary";
import { classifySensitivePath } from "../../security/path/sensitive-paths";
import { parseShellCommand, shellWords } from "./shell-parser";

export interface ShellPathAssessment {
  hasExternalPath: boolean;
  hasSensitivePath: boolean;
  reasons: string[];
  ruleIds: string[];
}

export async function assessShellPaths(command: string, cwd: string): Promise<ShellPathAssessment> {
  const parsed = parseShellCommand(command);
  const workspace = await canonicalizeToolPath(cwd, cwd);
  let hasExternalPath = false;
  let hasSensitivePath = false;
  const reasons: string[] = [];
  const ruleIds: string[] = [];

  for (const segment of parsed.segments) {
    for (const word of shellWords(segment).slice(1)) {
      const candidate = pathCandidate(word, cwd);
      if (!candidate) continue;
      const target = await canonicalizeToolPath(candidate, cwd);
      const sensitive = classifySensitivePath(target);
      if (sensitive) {
        hasSensitivePath = true;
        reasons.push(`Command accesses a sensitive ${sensitive} path`);
        ruleIds.push(`shell.path.sensitive.${sensitive}`);
      } else if (!isWithinPath(target, workspace)) {
        hasExternalPath = true;
        reasons.push("Command accesses a path outside the workspace");
        ruleIds.push("shell.path.outside-workspace");
      }
    }
  }
  return { hasExternalPath, hasSensitivePath, reasons, ruleIds };
}

function pathCandidate(word: string, cwd: string): string | null {
  let raw = word.replace(/^[<>]+/, "").replace(/[;,]$/, "");
  const formUpload = raw.match(/^[^=]+=@(.+)$/);
  if (formUpload) raw = formUpload[1]!;
  else if (raw.startsWith("@")) raw = raw.slice(1);
  const clean = expandKnownPathVariables(raw, cwd);
  if (!clean || clean.startsWith("-") || /^[a-z]+:\/\//i.test(clean)) return null;
  if (clean === "~" || clean.startsWith("~/")) {
    return path.join(os.homedir(), clean.slice(2));
  }
  if (
    path.isAbsolute(clean) ||
    clean.startsWith("./") ||
    clean.startsWith("../") ||
    clean.includes("/") ||
    /^\.(?:env(?:\..*)?|envrc|npmrc|pypirc|netrc|pgpass|my\.cnf|git-credentials)$/i.test(clean)
  ) {
    return clean;
  }
  return null;
}

function expandKnownPathVariables(value: string, cwd: string): string {
  return value
    .replace(/^\$(?:HOME|\{HOME\})(?=\/|$)/, os.homedir())
    .replace(/^\$(?:PWD|\{PWD\})(?=\/|$)/, cwd);
}
