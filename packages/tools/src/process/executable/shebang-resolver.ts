import { open } from "node:fs/promises";
import path from "node:path";
import { SandboxProcessError } from "../sandbox-process-error";

const MAX_SHEBANG_BYTES = 4096;
const MAX_ENV_ARGUMENTS = 32;

export interface ShebangInvocation {
  readonly interpreter: string;
}

export async function readShebang(pathname: string): Promise<ShebangInvocation | undefined> {
  const handle = await open(pathname, "r");
  try {
    const buffer = Buffer.alloc(MAX_SHEBANG_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/, 1)[0] ?? "";
    if (!firstLine.startsWith("#!")) return undefined;
    const source = firstLine.slice(2).trim();
    const [interpreter, ...interpreterArguments] = splitShebangWords(source);
    if (!interpreter || !path.isAbsolute(interpreter)) throw malformedShebang();
    if (interpreter !== "/usr/bin/env") {
      return { interpreter };
    }
    return resolveEnvInvocation(interpreterArguments);
  } finally {
    await handle.close();
  }
}

function resolveEnvInvocation(arguments_: readonly string[]): ShebangInvocation {
  let argumentsList = [...arguments_];
  if (argumentsList[0] === "-S" || argumentsList[0] === "--split-string") {
    argumentsList = argumentsList.slice(1);
  }
  while (argumentsList[0]?.startsWith("-")) {
    const option = argumentsList.shift()!;
    if (option === "-u" || option === "--unset") argumentsList.shift();
    else if (option.includes("=")) continue;
    else throw malformedShebang();
  }
  while (argumentsList[0]?.includes("=") && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argumentsList[0])) {
    argumentsList.shift();
  }
  const interpreter = argumentsList.shift();
  if (!interpreter || argumentsList.length > MAX_ENV_ARGUMENTS) throw malformedShebang();
  return { interpreter };
}

function splitShebangWords(source: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (const character of source) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (character === quote) quote = undefined;
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
  if (escaped || quote) throw malformedShebang();
  if (current) words.push(current);
  return words;
}

function malformedShebang(): SandboxProcessError {
  return new SandboxProcessError(
    "sandbox_runtime_dependency_unresolved",
    "Executable has an unsupported or malformed shebang.",
  );
}
