import { createAbortError } from "@omni-agent/core";

export async function normalizePromptResult<T>(result: Promise<T>): Promise<T> {
  try {
    return await result;
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === "ExitPromptError" || error.name === "AbortPromptError")
    ) {
      throw createAbortError();
    }
    throw error;
  }
}
