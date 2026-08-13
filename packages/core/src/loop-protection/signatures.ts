import { createHash } from "node:crypto";
import type { ToolCallContent } from "../messages";
import type { ToolResult } from "../types";

export function buildToolResultSignature(
  call: ToolCallContent,
  toolIdentity: string | undefined,
  result: ToolResult,
): string | null {
  return digest(
    {
      toolIdentity: toolIdentity ?? `unregistered:${call.name}`,
      arguments: call.arguments,
      result: { isError: result.isError, content: result.content },
    },
    toolIdentity ?? `unregistered:${call.name}`,
  );
}

export function buildErrorSignature(
  toolIdentity: string | undefined,
  toolName: string,
  result: ToolResult,
): string | null {
  return digest(
    {
      toolIdentity: toolIdentity ?? `unregistered:${toolName}`,
      errorContent: result.content,
    },
    toolIdentity ?? `unregistered:${toolName}`,
  );
}

export function buildBatchFingerprint(signatures: readonly string[]): string | null {
  return digest([...signatures].sort(), "batch");
}

export function buildSequenceFingerprint(signatures: readonly string[]): string | null {
  return digest(signatures, "sequence");
}

export function stableStringify(value: unknown): string | null {
  try {
    const serialized = JSON.stringify(value, (_key, current) => {
      if (current === null || typeof current !== "object" || Array.isArray(current)) {
        return current;
      }
      const record = current as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(record).sort()) sorted[key] = record[key];
      return sorted;
    });
    return serialized ?? null;
  } catch {
    return null;
  }
}

function digest(value: unknown, namespace: string): string | null {
  const serialized = stableStringify(value);
  if (serialized === null) return null;
  const hash = createHash("sha256").update(serialized).digest("hex");
  return `${namespace}::${hash}`;
}
