export function findPositionalArgument(
  args: readonly string[],
  start = 0,
  optionsWithValue?: ReadonlySet<string>,
): { index: number; value: string } | null {
  for (let index = start; index < args.length; index += 1) {
    const argument = args[index]!;
    if (optionsWithValue?.has(argument)) {
      index += 1;
      continue;
    }
    if (!argument.startsWith("-")) return { index, value: argument };
  }
  return null;
}
