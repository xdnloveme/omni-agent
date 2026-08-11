export interface ParsedShellCommand {
  segments: string[];
  redirections: ShellRedirection[];
  hasRedirection: boolean;
  hasOutputRedirection: boolean;
  hasDynamicExecution: boolean;
  malformed: boolean;
}

export interface ShellRedirection {
  operator: string;
  target: string;
}

export function parseShellCommand(command: string): ParsedShellCommand {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let substitutionDepth = 0;
  let hasRedirection = false;
  let hasOutputRedirection = false;
  let hasDynamicExecution = false;

  const push = () => {
    if (current.trim()) segments.push(current.trim());
    current = "";
  };

  for (let index = 0; index < command.length; index++) {
    const character = command[index]!;
    const next = command[index + 1] ?? "";
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      current += character;
      escaped = true;
      continue;
    }
    if (quote) {
      current += character;
      if (character === quote) quote = null;
      else if (quote === '"' && (character === "`" || (character === "$" && next === "("))) {
        hasDynamicExecution = true;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      current += character;
      continue;
    }
    if (character === "`" || (character === "$" && next === "(")) {
      hasDynamicExecution = true;
      if (character === "$" && next === "(") substitutionDepth++;
      current += character;
      continue;
    }
    if (character === ")" && substitutionDepth > 0) {
      substitutionDepth--;
      current += character;
      continue;
    }
    if (character === ">" || character === "<") {
      hasRedirection = true;
      if (character === ">") hasOutputRedirection = true;
      if (next === "(" || (character === "<" && next === "<")) hasDynamicExecution = true;
      current += character;
      continue;
    }
    if (substitutionDepth === 0 && (character === "|" || character === ";" || character === "&")) {
      push();
      if ((character === "|" || character === "&") && next === character) index++;
      continue;
    }
    current += character;
  }
  push();
  return {
    segments: segments.length ? segments : [command],
    redirections: extractRedirections(command),
    hasRedirection,
    hasOutputRedirection,
    hasDynamicExecution,
    malformed: quote !== null || escaped || substitutionDepth !== 0,
  };
}

function extractRedirections(command: string): ShellRedirection[] {
  const redirections: ShellRedirection[] = [];
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let index = 0; index < command.length; index++) {
    const character = command[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character !== ">" && character !== "<") continue;

    const operatorStart = index;
    while (/[<>&|]/.test(command[index + 1] ?? "")) index++;
    const operator = command.slice(operatorStart, index + 1);
    let targetIndex = index + 1;
    while (/\s/.test(command[targetIndex] ?? "")) targetIndex++;
    const parsedTarget = readShellToken(command, targetIndex);
    if (parsedTarget.value) redirections.push({ operator, target: parsedTarget.value });
    index = Math.max(index, parsedTarget.end - 1);
  }
  return redirections;
}

function readShellToken(command: string, start: number): { value: string; end: number } {
  let value = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let index = start;
  for (; index < command.length; index++) {
    const character = command[index]!;
    if (escaped) {
      value += character;
      escaped = false;
    } else if (character === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (character === quote) quote = null;
      else value += character;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s|[|;&<>]/.test(character)) {
      break;
    } else {
      value += character;
    }
  }
  return { value, end: index };
}

export function shellWords(segment: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const character of segment) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (character === quote) quote = null;
      else current += character;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/.test(character)) {
      if (current) words.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  if (current) words.push(current);
  return words;
}
