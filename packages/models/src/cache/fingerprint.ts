import { createHash } from "node:crypto";
import type { ModelCacheFingerprint, ModelRequest, RuntimeModelSelection } from "@omni-agent/core";

export const MODEL_CACHE_SEMANTICS_VERSION = 1;

export class ModelCacheFingerprinter {
  fingerprint(selection: RuntimeModelSelection, request: ModelRequest): ModelCacheFingerprint {
    const staticPrefixDigest = digestCacheValue({
      systemPrompt: request.systemPrompt,
      tools: request.tools ?? [],
    });
    const messageDigests = request.messages.map(digestCacheValue);
    const requestSemanticsDigest = digestCacheValue({
      providerId: selection.providerId,
      modelId: selection.modelId,
      requestModelId: selection.requestModelId,
      settings: selection.settings,
      requestHeadersDigest: digestCacheValue(selection.requestHeaders ?? {}),
      semanticsVersion: MODEL_CACHE_SEMANTICS_VERSION,
    });
    return {
      staticPrefixDigest,
      messageDigests,
      requestSemanticsDigest,
      requestDigest: digestCacheValue({
        staticPrefixDigest,
        messageDigests,
        requestSemanticsDigest,
      }),
    };
  }
}

export function digestCacheValue(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (value === undefined) return { $undefined: true };
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}
