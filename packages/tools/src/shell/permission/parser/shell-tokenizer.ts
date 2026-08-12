import type { ParsedShellWord, ShellRedirection, ShellToken } from "./types";

export interface TokenizeResult {
  tokens: ShellToken[];
  malformed: boolean;
  dynamic: boolean;
}

export function tokenizeShell(source: string): TokenizeResult {
  const tokens: ShellToken[] = [];
  let index = 0;
  let malformed = false;
  let dynamic = false;

  while (index < source.length) {
    if (/\s/.test(source[index]!)) {
      index += 1;
      continue;
    }
    const control = readControl(source, index);
    if (control) {
      tokens.push({
        kind: "control",
        operator: control,
        start: index,
        end: index + control.length,
      });
      index += control.length;
      continue;
    }
    if (["<", ">"].includes(source[index]!) && source[index + 1] === "(") {
      const word = readWord(source, index);
      dynamic ||= word.dynamic;
      malformed ||= word.malformed || word.word === null;
      if (!word.word) break;
      tokens.push({ kind: "word", word: word.word, start: word.word.start, end: word.word.end });
      index = word.word.end;
      continue;
    }
    const redirection = readRedirection(source, index);
    if (redirection) {
      const target = readWord(source, redirection.targetStart);
      dynamic ||= target.dynamic;
      malformed ||= target.malformed || target.word === null;
      const value: ShellRedirection = {
        operator: redirection.operator,
        target: target.word?.value ?? "",
        ...(redirection.sourceFd === undefined ? {} : { sourceFd: redirection.sourceFd }),
      };
      const end = target.word?.end ?? redirection.targetStart;
      tokens.push({ kind: "redirection", redirection: value, start: index, end });
      index = Math.max(end, redirection.targetStart);
      continue;
    }
    const word = readWord(source, index);
    dynamic ||= word.dynamic;
    malformed ||= word.malformed || word.word === null;
    if (!word.word) break;
    tokens.push({ kind: "word", word: word.word, start: word.word.start, end: word.word.end });
    index = word.word.end;
  }
  return { tokens, malformed, dynamic };
}

function readControl(source: string, index: number) {
  const rest = source.slice(index);
  if (rest.startsWith("&&")) return "&&" as const;
  if (rest.startsWith("||")) return "||" as const;
  if (rest.startsWith("|")) return "|" as const;
  if (rest.startsWith(";")) return ";" as const;
  if (rest.startsWith("&") && !rest.startsWith("&>")) return "&" as const;
  return undefined;
}

function readRedirection(
  source: string,
  index: number,
): { operator: string; sourceFd?: number; targetStart: number } | null {
  const match = source.slice(index).match(/^(?:(\d+))?(&>|>>|<<|<>|>&|<&|>|<)/);
  if (!match) return null;
  let targetStart = index + match[0].length;
  while (/\s/.test(source[targetStart] ?? "")) targetStart += 1;
  return {
    operator: match[2]!,
    ...(match[1] === undefined ? {} : { sourceFd: Number(match[1]) }),
    targetStart,
  };
}

function readWord(
  source: string,
  start: number,
): { word: ParsedShellWord | null; malformed: boolean; dynamic: boolean } {
  let index = start;
  let raw = "";
  let value = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let quoted = false;
  let dynamic = false;
  let substitutionDepth = 0;
  let backtick = false;

  for (; index < source.length; index += 1) {
    const character = source[index]!;
    const next = source[index + 1] ?? "";
    if (escaped) {
      raw += character;
      value += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      raw += character;
      escaped = true;
      continue;
    }
    if (quote) {
      raw += character;
      if (character === quote) quote = null;
      else value += character;
      if (quote === '"' && (character === "`" || (character === "$" && next === "(")))
        dynamic = true;
      continue;
    }
    if (character === "'" || character === '"') {
      raw += character;
      quote = character;
      quoted = true;
      continue;
    }
    if (character === "`") {
      dynamic = true;
      backtick = !backtick;
      raw += character;
      value += character;
      continue;
    }
    if ((character === "$" || character === "<" || character === ">") && next === "(") {
      dynamic = true;
      substitutionDepth += 1;
      raw += `${character}(`;
      value += `${character}(`;
      index += 1;
      continue;
    }
    if (substitutionDepth > 0) {
      if (character === "(") substitutionDepth += 1;
      if (character === ")") substitutionDepth -= 1;
      raw += character;
      value += character;
      continue;
    }
    if (/\s/.test(character) || readControl(source, index) || readRedirection(source, index)) break;
    raw += character;
    value += character;
  }
  return {
    word: index === start ? null : { raw, value, quoted, start, end: index },
    malformed: quote !== null || escaped || substitutionDepth > 0 || backtick,
    dynamic,
  };
}
