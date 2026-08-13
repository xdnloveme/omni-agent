export function estimateContextTextTokens(text: string): number {
  let asciiBytes = 0;
  let nonAsciiBytes = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x7f) {
      asciiBytes += 1;
    } else if (codePoint <= 0x7ff) {
      nonAsciiBytes += 2;
    } else if (codePoint <= 0xffff) {
      nonAsciiBytes += 3;
    } else {
      nonAsciiBytes += 4;
    }
  }
  return Math.ceil(asciiBytes / 4 + nonAsciiBytes / 2);
}
