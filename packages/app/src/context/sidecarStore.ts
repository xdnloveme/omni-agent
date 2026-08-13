import { rename } from "node:fs/promises";
import { InterprocessFileLock } from "@omni-agent/core";
import type { AtomicJsonFile } from "../persistence/atomic-json-file";
import type { ContextSidecarLayout } from "./sidecarLayout";

export function createContextSidecarLock(
  layout: ContextSidecarLayout,
  sessionId: string,
): InterprocessFileLock {
  return new InterprocessFileLock(layout.contextLockPath(sessionId), {
    retryMs: 25,
    timeoutMs: 5_000,
  });
}

export async function readValidatedSidecar<T>(input: {
  readonly file: AtomicJsonFile<T>;
  readonly path: string;
  readonly validate: (value: unknown) => asserts value is T;
  readonly label: string;
  readonly onDiagnostic?: (message: string) => void;
}): Promise<T | undefined> {
  let value: T | undefined;
  try {
    value = await input.file.read();
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    await quarantine(input, error);
    return undefined;
  }
  if (value === undefined) return undefined;
  try {
    input.validate(value);
    return value;
  } catch (error) {
    await quarantine(input, error);
    return undefined;
  }
}

async function quarantine(
  input: {
    readonly path: string;
    readonly label: string;
    readonly onDiagnostic?: (message: string) => void;
  },
  error: unknown,
): Promise<void> {
  try {
    await rename(input.path, `${input.path}.corrupt-${Date.now()}`);
  } catch (renameError) {
    if ((renameError as NodeJS.ErrnoException).code !== "ENOENT") throw renameError;
  }
  input.onDiagnostic?.(`${input.label} was corrupt and quarantined: ${errorMessage(error)}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
