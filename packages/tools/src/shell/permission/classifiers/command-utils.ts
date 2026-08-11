import path from "node:path";

export function commandIndex(words: readonly string[]): number {
  return words.findIndex((word) => !/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(word));
}

export function commandName(words: readonly string[]): string {
  const index = commandIndex(words);
  return index < 0 ? "" : path.basename(words[index]!).toLowerCase();
}

export function commandArguments(words: readonly string[]): readonly string[] {
  const index = commandIndex(words);
  return index < 0 ? [] : words.slice(index + 1);
}

export function subcommand(words: readonly string[]): string {
  return commandArguments(words).find((word) => !word.startsWith("-")) ?? "";
}
