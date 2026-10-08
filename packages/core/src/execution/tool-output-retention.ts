import { isAbortError, throwIfAborted } from "./abort";
import type { ToolResult } from "../types";
import { TextOutputPreview } from "./text-output-preview";
import { outputFailure, type OutputCallContext, type CapturedOutputSource } from "./output";

/** Store content before reducing its model-facing representation. No tool-name dispatch. */
export async function retainToolOutput(
  result: ToolResult,
  call?: OutputCallContext,
): Promise<ToolResult> {
  if (!call) {
    if (!result.content.some((part) => part.type === "text" && part.outputSource)) return result;
    const hasCapture = result.content.some(
      (part) => part.type === "text" && part.outputSource && !("kind" in part.outputSource),
    );
    const clean = structuredClone(result);
    const metadata = { ...clean.meta };
    clean.content = clean.content.map(withoutPreviewSource);
    delete metadata.output;
    clean.meta = metadata;
    return hasCapture ? outputFailure(clean) : clean;
  }
  const original = result;
  const clean = structuredClone(original);
  let finishAttempted = false;
  let readValidated = false;
  // Validated pages keep their upstream bound even if saving independent content fails.
  const pages = new Set<number>();
  try {
    throwIfAborted(call.signal);
    if (clean.meta?.output)
      clean.meta = {
        ...clean.meta,
        output: await call.session.resolve({ outputId: clean.meta.output.id }, call.signal),
      };
    if (clean.meta?.outputRead) {
      await call.session.resolve(clean.meta.outputRead, call.signal);
      readValidated = true;
    }
    const mapped = new Set<number>();
    const sources: CapturedOutputSource[] = [];
    for (const [index, part] of clean.content.entries()) {
      if (part.type !== "text" || !part.outputSource) continue;
      const origin = part.outputSource;
      if ("kind" in origin) {
        if (origin.kind !== "page") throw new Error("Invalid output content source");
        mapped.add(index);
        pages.add(index);
        continue;
      }
      if (
        !call.writer ||
        origin.outputId !== call.writer.id ||
        !Array.isArray(origin.partIds) ||
        !origin.partIds.length ||
        origin.partIds.some((id) => typeof id !== "string" || !id) ||
        new Set(origin.partIds).size !== origin.partIds.length
      ) {
        throw new Error("Invalid output preview source");
      }
      mapped.add(index);
      sources.push(origin);
    }
    // The local indices are derived only after middleware. No slot-based provenance crosses it.
    clean.content = clean.content.map(withoutPreviewSource);
    const structuredBytes =
      clean.structuredContent === undefined
        ? 0
        : Buffer.byteLength(JSON.stringify(clean.structuredContent));
    const textBytes = clean.content.reduce(
      (total, part, index) =>
        total + (part.type === "text" && !mapped.has(index) ? Buffer.byteLength(part.text) : 0),
      0,
    );
    // Structured data is indivisible: either keep it intact or retain it as JSON.
    const retainStructured =
      structuredBytes > 0 && textBytes + structuredBytes > call.session.previewBytes;
    const budgets = textPreviewBudgets(
      clean.content,
      call.session.previewBytes - (retainStructured ? 0 : structuredBytes),
      mapped,
    );
    const content = [...clean.content];
    for (let index = 0; index < content.length; index++) {
      const part = content[index]!;
      if (
        mapped.has(index) ||
        part.type !== "text" ||
        Buffer.byteLength(part.text) <= budgets.get(index)!
      )
        continue;
      if (call.failed) {
        content[index] = { ...part, text: preview(part.text, budgets.get(index)!) };
        continue;
      }
      call.writer ??= await call.session.create(call.toolCallId, call.signal);
      const saved = await call.writer.createPart(
        { label: `content-${index}`, mediaType: "text/plain" },
        call.signal,
      );
      await saved.append(part.text, call.signal);
      content[index] = {
        ...part,
        text:
          preview(part.text, budgets.get(index)!) +
          `\nSaved output: ${call.writer.id}, part: ${saved.id}.`,
      };
    }
    clean.content = content;
    if (clean.structuredContent !== undefined && retainStructured) {
      if (call.failed) throw new Error("Output capture failed");
      call.writer ??= await call.session.create(call.toolCallId, call.signal);
      const saved = await call.writer.createPart(
        { label: "structured", mediaType: "application/json" },
        call.signal,
      );
      await saved.append(JSON.stringify(clean.structuredContent), call.signal);
      delete clean.structuredContent;
      clean.meta = { ...clean.meta, structuredOutputPart: saved.id };
    }
    if (call.writer) {
      finishAttempted = true;
      const finished = await call.writer.finish({
        interrupted: call.interrupted,
        signal: call.signal,
        failure: call.failed
          ? "persistence_error"
          : call.unsupportedContent
            ? "unsupported_content"
            : undefined,
      });
      const record = await call.session.resolve({ outputId: finished.id }, call.signal);
      if (
        record.toolCallId !== call.toolCallId ||
        sources.some(
          (entry) =>
            entry.outputId !== record.id ||
            entry.partIds.some((id) => !record.parts.some((part) => part.id === id)),
        )
      ) {
        throw new Error("Output preview source does not match captured parts");
      }
      clean.meta = { ...clean.meta, output: record };
      clean.content = [
        ...clean.content,
        {
          type: "text",
          text: `Output ${record.id} (${record.state}${record.reason ? `: ${record.reason}` : ""}). Parts: ${record.parts.map((p) => `${p.id}${p.label ? ` [${p.label}]` : ""} (${p.bytes} bytes${p.complete ? "" : ", incomplete"})`).join(", ")}.`,
        },
      ];
    }
    throwIfAborted(call.signal);
    return call.failed ? outputFailure(clean) : clean;
  } catch (error) {
    if (isAbortError(error, call.signal)) throw error;
    // A contract failure must not leave a successfully opened capture in the writing state.
    // Do not retry finish after an uncertain storage failure.
    if (call.writer && !finishAttempted) {
      try {
        await call.writer.finish({ signal: call.signal, failure: "persistence_error" });
      } catch (failure) {
        if (isAbortError(failure, call.signal)) throw failure;
        // The result below reports persistence failure; no unverified reference is published.
      }
    }
    // Never retain an unvalidated reference or a second unbounded body on storage failure.
    const fallback = { ...original, meta: { ...original.meta } };
    delete fallback.meta.output;
    if (!readValidated) delete fallback.meta.outputRead;
    fallback.content = fallback.content.map(withoutPreviewSource);
    const fallbackStructuredBytes =
      fallback.structuredContent === undefined
        ? 0
        : Buffer.byteLength(JSON.stringify(fallback.structuredContent));
    const fallbackTextBytes = original.content.reduce(
      (total, part, index) =>
        total + (part.type === "text" && !pages.has(index) ? Buffer.byteLength(part.text) : 0),
      0,
    );
    const dropStructured = fallbackTextBytes + fallbackStructuredBytes > call.session.previewBytes;
    if (dropStructured) delete fallback.structuredContent;
    const budgets = textPreviewBudgets(
      original.content,
      call.session.previewBytes - (dropStructured ? 0 : fallbackStructuredBytes),
      pages,
    );
    return outputFailure({
      ...fallback,
      content: fallback.content.map((part, index) =>
        part.type === "text" && !pages.has(index)
          ? { ...part, text: preview(part.text, budgets.get(index)!) }
          : part,
      ),
      meta: { ...fallback.meta, outputPersistence: "failed" },
    });
  }
}

function preview(text: string, maximum: number): string {
  const buffer = new TextOutputPreview(maximum);
  buffer.append(Buffer.from(text));
  return buffer.text();
}

/** Share one body budget across independent text blocks; small blocks keep their full text.
 * Captured previews and pages already have an upstream presentation contract.
 * Navigation references added after projection are not body bytes.
 */
function textPreviewBudgets(
  content: ToolResult["content"],
  maximum: number,
  excluded: ReadonlySet<number> = new Set(),
): Map<number, number> {
  const entries = content.flatMap((part, index) =>
    part.type === "text" && !excluded.has(index)
      ? [{ index, bytes: Buffer.byteLength(part.text) }]
      : [],
  );
  entries.sort((a, b) => a.bytes - b.bytes || a.index - b.index);
  const budgets = new Map<number, number>();
  let remaining = Math.max(0, maximum);
  for (const [position, entry] of entries.entries()) {
    const share = Math.floor(remaining / (entries.length - position));
    const allocated = Math.min(entry.bytes, share);
    budgets.set(entry.index, allocated);
    remaining -= allocated;
  }
  return budgets;
}

/** Strip the internal binding on every return path, including persistence failure. */
function withoutPreviewSource(part: ToolResult["content"][number]): ToolResult["content"][number] {
  if (part.type !== "text" || part.outputSource === undefined) return part;
  const clean = { ...part };
  delete clean.outputSource;
  return clean;
}
